-- SCH-2: safe pause-first policy editing and terminal cancellation.
-- Separate additive migration. Never delete existing Tasks/messages or historical firings.
alter table public.ai_agent_task_triggers
 drop constraint if exists ai_agent_task_triggers_status_check;
alter table public.ai_agent_task_triggers
 add constraint ai_agent_task_triggers_status_check
 check (status in ('enabled','paused','completed','cancelled'));
alter table public.ai_agent_task_triggers
 add column if not exists edited_at timestamptz,
 add column if not exists edited_by uuid,
 add column if not exists cancelled_at timestamptz,
 add column if not exists cancelled_by uuid;

-- Mutations serialize with claims via a trigger-row lock. A claimed firing
-- with a live lease blocks editing and cancellation; operator must reconcile
-- the already-started Task separately, never blindly re-send.
create or replace function public.update_reviewed_agent_task_trigger_policy(
 p_account_id uuid,p_trigger_id uuid,p_actor_user_id uuid,
 p_expected_policy_version integer,p_schedule_kind text,
 p_next_fire_at timestamptz,p_interval_minutes integer,p_overlap_policy text
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare r public.ai_agent_task_triggers%rowtype;
        v_skipped integer;
begin
 if not exists(select 1 from public.profiles p where p.user_id=p_actor_user_id
    and p.account_id=p_account_id and p.account_role in ('owner','admin')) then
  raise exception 'AGENT_TASK_TRIGGER_EDIT_UNAUTHORIZED';
 end if;
 if p_overlap_policy is null or p_overlap_policy not in ('skip','defer') then
  raise exception 'AGENT_TASK_TRIGGER_OVERLAP_POLICY_INVALID';
 end if;
 select * into r from public.ai_agent_task_triggers
  where id=p_trigger_id and account_id=p_account_id for update;
 if not found then return jsonb_build_object('updated',false,'reason','NOT_FOUND'); end if;
 if r.status<>'paused' then
  return jsonb_build_object('updated',false,'reason','REQUIRES_PAUSE');
 end if;
 if p_expected_policy_version is null or p_expected_policy_version<>r.policy_version then
  return jsonb_build_object('updated',false,'reason','STALE_POLICY_VERSION',
    'policy_version',r.policy_version);
 end if;
 if r.approved_revision_id is null or r.approved_by is null then
  return jsonb_build_object('updated',false,'reason','REVIEW_REQUIRED');
 end if;
 if r.trigger_kind='schedule' then
  if p_schedule_kind is null or p_schedule_kind not in ('once','recurring')
    or p_next_fire_at is null
    or p_next_fire_at<=pg_catalog.clock_timestamp()+interval '1 minute'
    or p_next_fire_at>pg_catalog.clock_timestamp()+interval '366 days'
    or (p_schedule_kind='once' and p_interval_minutes is not null)
    or (p_schedule_kind='recurring' and
        (p_interval_minutes is null or p_interval_minutes not between 5 and 525600))
  then raise exception 'AGENT_TASK_TRIGGER_EDIT_SCHEDULE_INVALID'; end if;
 elsif r.trigger_kind='business_event' then
  if p_schedule_kind is not null or p_next_fire_at is not null
     or p_interval_minutes is not null then
   raise exception 'AGENT_TASK_TRIGGER_EDIT_EVENT_SHAPE_INVALID';
  end if;
 else raise exception 'AGENT_TASK_TRIGGER_EDIT_KIND_INVALID'; end if;

 if exists(select 1 from public.ai_agent_task_trigger_firings f
    where f.trigger_id=p_trigger_id and f.account_id=p_account_id
      and f.status='claimed' and f.lease_expires_at>pg_catalog.now()) then
  return jsonb_build_object('updated',false,'reason','CLAIM_IN_FLIGHT');
 end if;
 update public.ai_agent_task_trigger_firings
 set status='skipped',skip_reason='SCHEDULE_POLICY_REPLACED',
   claimed_by=null,lease_expires_at=null,last_error=null,updated_at=pg_catalog.now()
 where trigger_id=p_trigger_id and account_id=p_account_id
   and status in ('pending','failed','claimed');
 get diagnostics v_skipped=row_count;
 update public.ai_agent_task_triggers
 set policy_version=policy_version+1,overlap_policy=p_overlap_policy,
     schedule_kind=p_schedule_kind,next_fire_at=p_next_fire_at,
     interval_minutes=p_interval_minutes,edited_at=pg_catalog.now(),
     edited_by=p_actor_user_id,updated_at=pg_catalog.now()
 where id=p_trigger_id and account_id=p_account_id returning * into r;
 return jsonb_build_object('updated',true,'status','paused',
  'policy_version',r.policy_version,'skipped_firings',v_skipped);
end;
$$;
revoke all on function public.update_reviewed_agent_task_trigger_policy(
 uuid,uuid,uuid,integer,text,timestamptz,integer,text) from public,anon,authenticated;
grant execute on function public.update_reviewed_agent_task_trigger_policy(
 uuid,uuid,uuid,integer,text,timestamptz,integer,text) to service_role;

create or replace function public.cancel_reviewed_agent_task_trigger(
 p_account_id uuid,p_trigger_id uuid,p_actor_user_id uuid,
 p_expected_policy_version integer
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare r public.ai_agent_task_triggers%rowtype;
 v_skipped integer;
 v_tasks integer;
begin
 if not exists(select 1 from public.profiles p where p.user_id=p_actor_user_id
    and p.account_id=p_account_id and p.account_role in ('owner','admin')) then
  raise exception 'AGENT_TASK_TRIGGER_CANCEL_UNAUTHORIZED';
 end if;
 select * into r from public.ai_agent_task_triggers
 where id=p_trigger_id and account_id=p_account_id for update;
 if not found then return jsonb_build_object('cancelled',false,'reason','NOT_FOUND'); end if;
 if r.status='cancelled' then
  return jsonb_build_object('cancelled',true,'already_cancelled',true,
    'skipped_firings',0,'existing_tasks_untouched',true);
 end if;
 if p_expected_policy_version is null or p_expected_policy_version<>r.policy_version then
  return jsonb_build_object('cancelled',false,'reason','STALE_POLICY_VERSION',
    'policy_version',r.policy_version);
 end if;
 if exists(select 1 from public.ai_agent_task_trigger_firings f
    where f.trigger_id=p_trigger_id and f.account_id=p_account_id
      and f.status='claimed' and f.lease_expires_at>pg_catalog.now()) then
  return jsonb_build_object('cancelled',false,'reason','CLAIM_IN_FLIGHT');
 end if;
 update public.ai_agent_task_triggers set status='cancelled',
  cancelled_at=pg_catalog.now(),cancelled_by=p_actor_user_id,
  updated_at=pg_catalog.now() where id=p_trigger_id and account_id=p_account_id;
 update public.ai_agent_task_trigger_firings
 set status='skipped',skip_reason='SCHEDULE_POLICY_CANCELLED',
     claimed_by=null,lease_expires_at=null,last_error=null,updated_at=pg_catalog.now()
 where trigger_id=p_trigger_id and account_id=p_account_id
   and status in ('pending','failed','claimed');
 get diagnostics v_skipped=row_count;
 select count(*) into v_tasks from public.ai_agent_task_trigger_firings
 where trigger_id=p_trigger_id and account_id=p_account_id and task_id is not null;
 return jsonb_build_object('cancelled',true,'already_cancelled',false,
   'status','cancelled','skipped_firings',v_skipped,
   'linked_tasks_untouched',v_tasks,'existing_tasks_untouched',true);
end;
$$;
revoke all on function public.cancel_reviewed_agent_task_trigger(
 uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.cancel_reviewed_agent_task_trigger(
 uuid,uuid,uuid,integer) to service_role;

-- Legacy, reviewed and queue paths must all agree on terminal cancellation.

create or replace function public.freeze_agent_task_trigger_firing_policy()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public
as $$
declare p public.ai_agent_task_triggers%rowtype;
begin
 select * into p from public.ai_agent_task_triggers
 where id=new.trigger_id and account_id=new.account_id for share;
 if not found then
  raise exception 'AGENT_TASK_TRIGGER_FIRING_ACCOUNT_MISMATCH';
 end if;
 if p.status <> 'enabled' then return null; end if;
 new.policy_snapshot:=jsonb_build_object(
  'policy_version',p.policy_version,
  'approved_revision_id',p.approved_revision_id,
  'approved_by',p.approved_by,
  'overlap_policy',p.overlap_policy,
  'config',p.config,'filters',p.filters,'created_by',p.created_by
 );
 return new;
end;
$$;
revoke all on function public.freeze_agent_task_trigger_firing_policy() from public,anon,authenticated;
drop trigger if exists ai_agent_task_trigger_firing_policy_freeze
 on public.ai_agent_task_trigger_firings;
create trigger ai_agent_task_trigger_firing_policy_freeze
 before insert on public.ai_agent_task_trigger_firings
 for each row execute function public.freeze_agent_task_trigger_firing_policy();


create or replace function public.set_agent_task_trigger_status(
  p_account_id uuid,
  p_trigger_id uuid,
  p_status text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_status not in ('enabled', 'paused') then
    raise exception 'AGENT_TASK_TRIGGER_STATUS_INVALID';
  end if;

  update public.ai_agent_task_triggers
     set status = p_status,
         updated_at = pg_catalog.now()
   where id = p_trigger_id
     and account_id = p_account_id
     and status not in ('completed','cancelled');

  return found;
end;
$$;

revoke all on function public.set_agent_task_trigger_status(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.set_agent_task_trigger_status(uuid,uuid,text)
  to service_role;


create or replace function public.set_reviewed_agent_task_trigger_status(
  p_account_id uuid,
  p_trigger_id uuid,
  p_status text,
  p_actor_user_id uuid
) returns boolean language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_trigger public.ai_agent_task_triggers%rowtype;
begin
  if p_status not in ('paused','enabled') or p_status is null then
    raise exception 'AGENT_TASK_TRIGGER_STATUS_INVALID';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.user_id=p_actor_user_id and p.account_id=p_account_id
      and p.account_role in ('owner','admin')
  ) then
    raise exception 'AGENT_TASK_TRIGGER_CONTROL_UNAUTHORIZED';
  end if;

  select * into v_trigger
  from public.ai_agent_task_triggers
  where id=p_trigger_id and account_id=p_account_id
  for update;
  if not found or v_trigger.status in ('completed','cancelled') then
    return false;
  end if;

  if p_status='enabled' then
    if not exists (
      select 1 from public.profiles p
      where p.user_id=p_actor_user_id and p.account_id=p_account_id
        and p.account_role='owner'
    ) then
      raise exception 'AGENT_TASK_TRIGGER_ENABLE_OWNER_ONLY';
    end if;
    if v_trigger.approved_revision_id is null
      or v_trigger.approved_by is null
      or not exists (
        select 1 from public.ai_agents a
        join public.ai_agent_revisions rev
          on rev.id=a.published_revision_id
         and rev.agent_id=a.id and rev.account_id=a.account_id
        where a.account_id=p_account_id
          and a.id=v_trigger.agent_id
          and a.status='active'
          and rev.status='published'
          and rev.id=v_trigger.approved_revision_id
      ) then
      raise exception 'AGENT_TASK_TRIGGER_REVIEW_REVISION_CHANGED';
    end if;
  end if;

  update public.ai_agent_task_triggers
  set status=p_status,updated_at=now()
  where id=p_trigger_id and account_id=p_account_id
    and status not in ('completed','cancelled');
  return found;
end;
$$;
revoke all on function public.set_reviewed_agent_task_trigger_status(uuid,uuid,text,uuid)
  from public,anon,authenticated;
grant execute on function public.set_reviewed_agent_task_trigger_status(uuid,uuid,text,uuid)
  to service_role;

create or replace function public.claim_next_agent_task_trigger_firing(
  p_worker_id text,
  p_lease_secs integer default 120
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_firing_id uuid;
  v_account_id uuid;
  v_result jsonb;
begin
  if length(btrim(coalesce(p_worker_id, ''))) = 0 then
    raise exception 'AGENT_TASK_TRIGGER_WORKER_ID_REQUIRED';
  end if;
  if length(p_worker_id) > 128 then
    raise exception 'AGENT_TASK_TRIGGER_WORKER_ID_TOO_LONG';
  end if;
  if p_lease_secs < 30 or p_lease_secs > 900 then
    raise exception 'AGENT_TASK_TRIGGER_LEASE_INVALID';
  end if;

  select firing.id, firing.account_id
    into v_firing_id, v_account_id
  from public.ai_agent_task_trigger_firings as firing
  join public.ai_agent_task_triggers as trigger
    on trigger.id = firing.trigger_id
   and trigger.account_id = firing.account_id
  left join public.ai_agent_task_trigger_claim_fairness as fairness
    on fairness.account_id = firing.account_id
  where trigger.status in ('enabled', 'completed')
    and coalesce((
      select policy.task_worker_enabled
      from public.ai_runtime_policies as policy
      where policy.account_id = firing.account_id
    ), true)
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
  order by coalesce(fairness.last_claimed_at, '-infinity'::timestamptz) asc,
    firing.available_at asc, firing.created_at asc, firing.id asc
  for update of firing, trigger skip locked
  limit 1;

  if v_firing_id is null then
    return null;
  end if;

  update public.ai_agent_task_trigger_firings
     set status = 'claimed',
         attempts = attempts + 1,
         lease_generation = lease_generation + 1,
         claimed_by = btrim(p_worker_id) || ':' || pg_catalog.gen_random_uuid()::text,
         lease_expires_at =
           pg_catalog.now() + make_interval(secs => p_lease_secs),
         last_error = null,
         updated_at = pg_catalog.now()
   where id = v_firing_id;

  insert into public.ai_agent_task_trigger_claim_fairness(account_id,last_claimed_at)
  values (v_account_id,pg_catalog.clock_timestamp())
  on conflict(account_id) do update
    set last_claimed_at = excluded.last_claimed_at;

  select jsonb_build_object(
    'firing_id', firing.id,
    'account_id', firing.account_id,
    'trigger_id', trigger.id,
    'task_type', trigger.task_type,
    'task_type_version', trigger.task_type_version,
    'agent_id', trigger.agent_id,
    'trigger_kind', trigger.trigger_kind,
    -- Config/filters and review binding are frozen when the firing is inserted.
    'config', coalesce(firing.policy_snapshot -> 'config', trigger.config),
    'filters', coalesce(firing.policy_snapshot -> 'filters', trigger.filters),
    'created_by', coalesce((firing.policy_snapshot ->> 'created_by'), trigger.created_by::text),
    'policy_version', coalesce((firing.policy_snapshot ->> 'policy_version')::integer, trigger.policy_version),
    'overlap_policy', coalesce(firing.policy_snapshot ->> 'overlap_policy', trigger.overlap_policy),
    'approved_revision_id', coalesce(firing.policy_snapshot ->> 'approved_revision_id', trigger.approved_revision_id::text),
    'source_key', firing.source_key,
    'scheduled_for', firing.scheduled_for,
    'attempts', firing.attempts,
    'claim_owner', firing.claimed_by,
    'lease_generation', firing.lease_generation,
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
$$;

revoke all on function public.claim_next_agent_task_trigger_firing(text,integer)
  from public, anon, authenticated;
grant execute on function public.claim_next_agent_task_trigger_firing(text,integer)
  to service_role;


