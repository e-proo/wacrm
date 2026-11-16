-- WACRM / SOF: TEST-only operator controls for automatic Agent Task worker and
-- explicit user closures. All writes are tenant scoped, audited and service only.
-- Existing migrations remain unchanged.
ALTER TABLE public.ai_runtime_policies
  ADD COLUMN task_worker_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.ai_runtime_policies.task_worker_enabled IS
  'Per-account TEST Agent Task queue processing switch. Does not pause inbound WhatsApp, Meta, or an already dispatched provider send.';

ALTER TABLE public.ai_agent_tasks
  ADD COLUMN manual_closure_kind text NULL
    CONSTRAINT ai_agent_tasks_manual_closure_kind_check
    CHECK (manual_closure_kind IN ('cancelled','finished_incomplete','finished_complete')),
  ADD COLUMN manual_closed_at timestamptz NULL,
  ADD COLUMN manual_closed_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN manual_closure_note text NULL
    CONSTRAINT ai_agent_tasks_manual_closure_note_check
    CHECK (manual_closure_note IS NULL OR length(manual_closure_note) <= 500);

CREATE TABLE public.ai_agent_task_worker_control_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled boolean NOT NULL,
  changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_agent_task_worker_control_events_account_created_idx
  ON public.ai_agent_task_worker_control_events(account_id,created_at DESC);
ALTER TABLE public.ai_agent_task_worker_control_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_agent_task_worker_control_events FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT ON public.ai_agent_task_worker_control_events TO service_role;

CREATE OR REPLACE FUNCTION public.set_agent_task_worker_enabled(
  p_account_id uuid, p_actor_user_id uuid, p_enabled boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE v_updated integer;
BEGIN
  IF p_account_id IS NULL OR p_actor_user_id IS NULL OR p_enabled IS NULL THEN
    RETURN jsonb_build_object('updated',false,'reason','invalid_input');
  END IF;
  UPDATE public.ai_runtime_policies
    SET task_worker_enabled=p_enabled, updated_by=p_actor_user_id, updated_at=now()
    WHERE account_id=p_account_id
    RETURNING 1 INTO v_updated;
  IF v_updated IS NULL THEN
    RETURN jsonb_build_object('updated',false,'reason','runtime_policy_missing');
  END IF;
  INSERT INTO public.ai_agent_task_worker_control_events(account_id,enabled,changed_by)
    VALUES(p_account_id,p_enabled,p_actor_user_id);
  RETURN jsonb_build_object('updated',true,'enabled',p_enabled);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_agent_task_worker_enabled(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_agent_task_worker_enabled(uuid,uuid,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_close_agent_task(
  p_account_id uuid, p_task_id uuid, p_actor_user_id uuid,
  p_mode text, p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $fn$
DECLARE
  v_task public.ai_agent_tasks%rowtype;
  v_total integer;
  v_completed integer;
  v_terminal text;
  v_request_id uuid;
  v_fulfilled boolean := false;
BEGIN
  IF p_account_id IS NULL OR p_task_id IS NULL OR p_actor_user_id IS NULL OR
     p_mode NOT IN ('cancel','finish_incomplete','finish_complete') OR
     length(coalesce(p_note,'')) > 500 THEN
    RETURN jsonb_build_object('updated',false,'reason','invalid_input');
  END IF;
  SELECT * INTO v_task FROM public.ai_agent_tasks
    WHERE account_id=p_account_id AND id=p_task_id FOR UPDATE;
  IF v_task.id IS NULL THEN
    RETURN jsonb_build_object('updated',false,'reason','not_found');
  END IF;
  IF v_task.status IN ('completed','partially_completed','failed','cancelled') THEN
    RETURN jsonb_build_object('updated',false,'reason','already_terminal','status',v_task.status);
  END IF;

  -- Serialize with outbound claims: queued/reserved items can be cancelled,
  -- but never erase a claimed transport send or uncertain result.
  PERFORM id FROM public.ai_agent_runs
    WHERE account_id=p_account_id AND task_id=p_task_id
    ORDER BY id FOR UPDATE;
  PERFORM id FROM public.ai_agent_task_outbound_messages
    WHERE account_id=p_account_id AND task_id=p_task_id
    ORDER BY id FOR UPDATE;
  PERFORM id FROM public.ai_agent_task_targets
    WHERE account_id=p_account_id AND task_id=p_task_id
    ORDER BY id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM public.ai_agent_runs
             WHERE account_id=p_account_id AND task_id=p_task_id
               AND status IN ('claimed','running'))
    OR EXISTS (SELECT 1 FROM public.ai_agent_task_outbound_messages
               WHERE account_id=p_account_id AND task_id=p_task_id
                 AND status IN ('sending','requires_reconciliation'))
    OR EXISTS (SELECT 1 FROM public.ai_agent_task_targets
               WHERE account_id=p_account_id AND task_id=p_task_id
                 AND status='sending') THEN
    RETURN jsonb_build_object('updated',false,'reason','in_flight_or_reconciliation');
  END IF;

  SELECT count(*), count(*) FILTER (WHERE status='completed')
    INTO v_total,v_completed
    FROM public.ai_agent_task_targets
    WHERE account_id=p_account_id AND task_id=p_task_id;

  IF p_mode='finish_complete' THEN
    -- The operator cannot manufacture successful target outcomes. Coverage
    -- must also be fulfilled. Otherwise use 'finish_incomplete'.
    IF v_total=0 OR v_completed<>v_total THEN
      RETURN jsonb_build_object('updated',false,'reason','targets_not_completed',
        'total',v_total,'completed',v_completed);
    END IF;
    IF v_task.task_type='coverage.sourcing' THEN
      IF coalesce(v_task.task_context->>'coverageRequestId','') !~
           '^[0-9a-fA-F-]{36}$' THEN
        RETURN jsonb_build_object('updated',false,'reason','coverage_not_fulfilled');
      END IF;
      v_request_id:=(v_task.task_context->>'coverageRequestId')::uuid;
      SELECT (status='fulfilled') INTO v_fulfilled
        FROM public.coverage_requests
        WHERE id=v_request_id AND account_id=p_account_id;
      IF NOT coalesce(v_fulfilled,false) THEN
        RETURN jsonb_build_object('updated',false,'reason','coverage_not_fulfilled');
      END IF;
    END IF;
    v_terminal:='completed';
  ELSIF p_mode='finish_incomplete' THEN
    v_terminal:='partially_completed';
  ELSE
    v_terminal:='cancelled';
  END IF;

  UPDATE public.ai_agent_task_outbound_messages
    SET status='cancelled',error_code='TASK_OPERATOR_CLOSED',
        claimed_by=NULL,lease_expires_at=NULL,updated_at=now()
    WHERE account_id=p_account_id AND task_id=p_task_id
      AND status='reserved';

  UPDATE public.ai_agent_runs
    SET status='cancelled',error_code='TASK_OPERATOR_CLOSED',
        claimed_by=NULL,lease_expires_at=NULL,completed_at=coalesce(completed_at,now()),
        updated_at=now()
    WHERE account_id=p_account_id AND task_id=p_task_id
      AND status='queued';

  IF p_mode<>'finish_complete' THEN
    UPDATE public.ai_agent_task_targets
      SET status='skipped',skip_reason='TASK_OPERATOR_CLOSED',
          claimed_by=NULL,lease_expires_at=NULL,completed_at=coalesce(completed_at,now()),
          next_action_at=NULL,updated_at=now()
      WHERE account_id=p_account_id AND task_id=p_task_id
        AND status NOT IN ('completed','skipped','failed','opted_out','exhausted');
  END IF;

  UPDATE public.ai_agent_tasks
    SET status=v_terminal,manual_closure_kind=CASE p_mode
      WHEN 'cancel' THEN 'cancelled'
      ELSE CASE WHEN p_mode='finish_complete' THEN 'finished_complete' ELSE 'finished_incomplete' END END,
      manual_closed_at=now(),manual_closed_by=p_actor_user_id,
      manual_closure_note=NULLIF(btrim(p_note),''),
      claimed_by=NULL,lease_expires_at=NULL,
      completed_at=coalesce(completed_at,now()),updated_at=now()
    WHERE account_id=p_account_id AND id=p_task_id;

  PERFORM public.append_agent_task_event(
    p_account_id,p_task_id,NULL,NULL,
    CASE WHEN p_mode='cancel' THEN 'task.cancelled'
      WHEN p_mode='finish_complete' THEN 'task.completed'
      ELSE 'task.partially_completed' END,
    'user',p_actor_user_id::text,
    jsonb_build_object('operator_mode',p_mode,'completed_targets',v_completed,
      'total_targets',v_total,'note',left(coalesce(p_note,''),500))
  );

  RETURN jsonb_build_object('updated',true,'status',v_terminal,
    'closure_kind',p_mode,'total',v_total,'completed',v_completed);
END
$fn$;
REVOKE ALL ON FUNCTION public.admin_close_agent_task(uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_close_agent_task(uuid,uuid,uuid,text,text) TO service_role;

-- Existing queue claimers must respect each tenant's TEST worker switch.
-- Their original SECURITY DEFINER and service-role-only grants are preserved.
CREATE OR REPLACE FUNCTION public.claim_next_agent_task(p_worker_id text, p_lease_secs integer DEFAULT 60)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_task_id uuid;
  v_account_id uuid;
begin
  if length(btrim(coalesce(p_worker_id, ''))) = 0 then
    raise exception 'AGENT_TASK_WORKER_ID_REQUIRED';
  end if;
  if p_lease_secs < 1 or p_lease_secs > 3600 then
    raise exception 'AGENT_TASK_LEASE_INVALID';
  end if;

  with candidate as (
    select t.id
    from public.ai_agent_tasks as t
    where t.status in ('scheduled', 'queued', 'running')
      and not exists (
        select 1 from public.ai_runtime_policies worker_policy
        where worker_policy.account_id=t.account_id
          and worker_policy.task_worker_enabled=false
      )
      and t.available_at <= now()
      and (t.scheduled_at is null or t.scheduled_at <= now())
      and (t.lease_expires_at is null or t.lease_expires_at < now())
    order by t.available_at asc, t.created_at asc, t.id asc
    for update skip locked
    limit 1
  )
  update public.ai_agent_tasks as t
     set status = 'running',
         started_at = coalesce(t.started_at, now()),
         claimed_by = p_worker_id,
         lease_expires_at = now() + make_interval(secs => p_lease_secs),
         attempt_count = t.attempt_count + 1
    from candidate
   where t.id = candidate.id
  returning t.id, t.account_id
       into v_task_id, v_account_id;

  if v_task_id is not null then
    perform public.append_agent_task_event(
      v_account_id,
      v_task_id,
      null,
      null,
      'task.claimed',
      'service',
      p_worker_id,
      jsonb_build_object('lease_secs', p_lease_secs)
    );
  end if;

  return v_task_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.claim_next_agent_task_trigger_firing(p_worker_id text, p_lease_secs integer DEFAULT 120)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_firing_id uuid;
  v_result jsonb;
begin
  if length(btrim(coalesce(p_worker_id, ''))) = 0 then
    raise exception 'AGENT_TASK_TRIGGER_WORKER_ID_REQUIRED';
  end if;
  if p_lease_secs < 30 or p_lease_secs > 900 then
    raise exception 'AGENT_TASK_TRIGGER_LEASE_INVALID';
  end if;

  select firing.id
    into v_firing_id
  from public.ai_agent_task_trigger_firings as firing
  join public.ai_agent_task_triggers as trigger
    on trigger.id = firing.trigger_id
   and trigger.account_id = firing.account_id
  where trigger.status in ('enabled', 'completed')
    and not exists (
      select 1 from public.ai_runtime_policies worker_policy
      where worker_policy.account_id=firing.account_id
        and worker_policy.task_worker_enabled=false
    )
    and (
      (
        firing.status in ('pending', 'failed')
        and firing.available_at <= pg_catalog.now()
      )
      or
      (
        firing.status = 'claimed'
        and firing.lease_expires_at is not null
        and firing.lease_expires_at <= pg_catalog.now()
      )
    )
    and firing.attempts < 5
  order by firing.available_at asc, firing.created_at asc, firing.id asc
  for update of firing skip locked
  limit 1;

  if v_firing_id is null then
    return null;
  end if;

  update public.ai_agent_task_trigger_firings
     set status = 'claimed',
         attempts = attempts + 1,
         claimed_by = btrim(p_worker_id),
         lease_expires_at =
           pg_catalog.now() + make_interval(secs => p_lease_secs),
         last_error = null,
         updated_at = pg_catalog.now()
   where id = v_firing_id;

  select jsonb_build_object(
    'firing_id', firing.id,
    'account_id', firing.account_id,
    'trigger_id', trigger.id,
    'task_type', trigger.task_type,
    'task_type_version', trigger.task_type_version,
    'agent_id', trigger.agent_id,
    'trigger_kind', trigger.trigger_kind,
    'config', trigger.config,
    'filters', trigger.filters,
    'created_by', trigger.created_by,
    'source_key', firing.source_key,
    'scheduled_for', firing.scheduled_for,
    'attempts', firing.attempts,
    'business_event',
      case
        when event.id is null then null
        else jsonb_build_object(
          'id', event.id,
          'event_type', event.event_type,
          'event_version', event.event_version,
          'subject_type', event.subject_type,
          'subject_id', event.subject_id,
          'correlation_id', event.correlation_id,
          'causation_id', event.causation_id,
          'payload', event.payload,
          'created_at', event.created_at
        )
      end
  )
    into v_result
  from public.ai_agent_task_trigger_firings as firing
  join public.ai_agent_task_triggers as trigger
    on trigger.id = firing.trigger_id
   and trigger.account_id = firing.account_id
  left join public.business_event_outbox as event
    on event.id = firing.business_event_id
   and event.account_id = firing.account_id
  where firing.id = v_firing_id;

  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.materialize_agent_task_trigger_firings(p_now timestamp with time zone DEFAULT now(), p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  r public.ai_agent_task_triggers%rowtype;
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 500));
  v_schedule_count integer := 0;
  v_event_count integer := 0;
begin
  for r in
    select trigger.*
    from public.ai_agent_task_triggers as trigger
    where trigger.status = 'enabled'
    and not exists (
      select 1 from public.ai_runtime_policies worker_policy
      where worker_policy.account_id=trigger.account_id
        and worker_policy.task_worker_enabled=false
    )
      and not exists (
        select 1 from public.ai_runtime_policies worker_policy
        where worker_policy.account_id=trigger.account_id
          and worker_policy.task_worker_enabled=false
      )
      and trigger.trigger_kind = 'schedule'
      and trigger.next_fire_at is not null
      and trigger.next_fire_at <= p_now
    order by trigger.next_fire_at asc, trigger.id asc
    for update skip locked
    limit v_limit
  loop
    insert into public.ai_agent_task_trigger_firings (
      account_id,
      trigger_id,
      source_kind,
      source_key,
      scheduled_for,
      available_at
    ) values (
      r.account_id,
      r.id,
      'schedule',
      'schedule:' || r.id::text || ':' ||
        to_char(r.next_fire_at at time zone 'UTC', 'YYYYMMDD"T"HH24MISS.US'),
      r.next_fire_at,
      p_now
    )
    on conflict (trigger_id, source_key) do nothing;

    if found then
      v_schedule_count := v_schedule_count + 1;
    end if;

    if r.schedule_kind = 'once' then
      update public.ai_agent_task_triggers
         set status = 'completed',
             next_fire_at = null,
             updated_at = p_now
       where id = r.id;
    else
      update public.ai_agent_task_triggers
         set next_fire_at =
               r.next_fire_at +
               make_interval(mins => r.interval_minutes),
             updated_at = p_now
       where id = r.id;
    end if;
  end loop;

  insert into public.ai_agent_task_trigger_firings (
    account_id,
    trigger_id,
    source_kind,
    source_key,
    business_event_id,
    available_at
  )
  select
    trigger.account_id,
    trigger.id,
    'business_event',
    'event:' || event.id::text,
    event.id,
    p_now
  from public.ai_agent_task_triggers as trigger
  join public.business_event_outbox as event
    on event.account_id = trigger.account_id
   and event.event_type = trigger.event_type
   and event.event_version = trigger.event_version
   and event.created_at >= trigger.created_at
  where trigger.status = 'enabled'
    and trigger.trigger_kind = 'business_event'
    and (
      not (trigger.filters ? 'subject_type')
      or event.subject_type = trigger.filters ->> 'subject_type'
    )
    and (
      not (trigger.filters ? 'subject_id')
      or event.subject_id = trigger.filters ->> 'subject_id'
    )
    and (
      not (trigger.filters ? 'payload_contains')
      or (
        jsonb_typeof(trigger.filters -> 'payload_contains') = 'object'
        and event.payload @> (trigger.filters -> 'payload_contains')
      )
    )
    and not exists (
      select 1
      from public.ai_agent_task_trigger_firings as existing
      where existing.trigger_id = trigger.id
        and existing.source_key = 'event:' || event.id::text
    )
  order by event.created_at asc, event.id asc, trigger.id asc
  limit v_limit
  on conflict (trigger_id, source_key) do nothing;

  get diagnostics v_event_count = row_count;

  return jsonb_build_object(
    'schedule_firings', v_schedule_count,
    'business_event_firings', v_event_count
  );
end;
$function$;
