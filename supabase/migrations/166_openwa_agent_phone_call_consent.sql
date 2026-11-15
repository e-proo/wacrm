-- Additive TEST-only explicit phone-call opt-in. Admin approval is scoped to
-- the chosen account, connection and canonical recipient; it expires within
-- four hours. No global cold-outreach toggle or Meta policy change.
ALTER TABLE public.whatsapp_openwa_pilot_allowlist
  ADD COLUMN consent_basis text NOT NULL DEFAULT 'verified_inbound'
    CHECK (consent_basis IN ('verified_inbound','phone_call')),
  ADD COLUMN consent_attested_at timestamptz;

CREATE OR REPLACE FUNCTION public.openwa_agent_phone_call_authorized(
  p_account uuid, p_connection uuid, p_contact uuid, p_conversation uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path TO 'pg_catalog','public','extensions'
AS $consent$
DECLARE
  v_recipient text;
  v_messages bigint;
  v_distinct bigint;
  v_invalid bigint;
BEGIN
  IF p_account IS NULL OR p_connection IS NULL OR p_contact IS NULL
     OR p_conversation IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.account_id=p_account AND c.id=p_conversation
      AND c.contact_id=p_contact
  ) THEN RETURN false; END IF;
  -- Never guess a phone from an existing OpenWA LID, or resolve ambiguity.
  SELECT count(*), count(distinct m.provider_chat_id),
         count(*) FILTER (WHERE m.provider_chat_id IS NULL
            OR m.provider_chat_id !~ '^[0-9]{5,20}@(c[.]us|lid)$'),
         max(m.provider_chat_id)
    INTO v_messages, v_distinct, v_invalid, v_recipient
  FROM public.messages m
  WHERE m.conversation_id=p_conversation
    AND m.connection_id=p_connection AND m.provider='openwa'
    AND m.sender_type='customer';
  IF v_messages > 0 THEN
    IF v_distinct<>1 OR v_invalid<>0 THEN RETURN false; END IF;
  ELSE
    SELECT c.phone_normalized || '@c.us' INTO v_recipient
    FROM public.contacts c
    WHERE c.id=p_contact AND c.account_id=p_account
      AND c.phone_normalized ~ '^[1-9][0-9]{7,14}$';
  END IF;
  IF v_recipient IS NULL THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1
    FROM public.whatsapp_connections wc
    JOIN public.whatsapp_connection_guardrails g
      ON g.account_id=wc.account_id AND g.connection_id=wc.id
    JOIN public.whatsapp_openwa_pilot_allowlist a
      ON a.account_id=wc.account_id AND a.connection_id=wc.id
    WHERE wc.account_id=p_account AND wc.id=p_connection
      AND wc.provider='openwa' AND wc.archived_at IS NULL
      AND wc.status IN ('ready','connected') AND wc.session_id IS NOT NULL
      AND g.pilot_enabled IS TRUE AND g.manual_paused IS FALSE
      AND (g.circuit_open_until IS NULL OR g.circuit_open_until<=now())
      AND a.workload='agent' AND a.active=true AND a.expires_at>now()
      AND a.consent_basis='phone_call' AND a.consent_attested_at IS NOT NULL
      AND a.recipient_hash=encode(extensions.digest(
        'openwa-pilot:v1:' || p_account::text || ':' ||
        p_connection::text || ':' || v_recipient, 'sha256'
      ),'hex')
  );
END $consent$;

REVOKE ALL ON FUNCTION public.openwa_agent_phone_call_authorized(uuid,uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.openwa_agent_phone_call_authorized(uuid,uuid,uuid,uuid)
  TO service_role;

-- Re-apply reserve_agent_task_outbound_message with a strictly scoped OpenWA consent alternative.
CREATE OR REPLACE FUNCTION public.reserve_agent_task_outbound_message(p_run_id uuid, p_policy_key text, p_policy_version integer, p_message_kind text, p_candidate_text text, p_template_name text, p_template_language text, p_template_params jsonb, p_max_followups integer, p_minimum_interval_minutes integer, p_maximum_interval_minutes integer, p_stop_on_reply boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_run public.ai_agent_runs%rowtype;
  v_task public.ai_agent_tasks%rowtype;
  v_target public.ai_agent_task_targets%rowtype;
  v_existing public.ai_agent_task_outbound_messages%rowtype;
  v_last_inbound_at timestamptz;
  v_session_active boolean;
  v_last_sent_at timestamptz;
  v_followup_number integer;
  v_reservation_id uuid;
  v_idempotency_key text;
  v_params jsonb:=coalesce(p_template_params,'[]'::jsonb);
begin
  if length(btrim(coalesce(p_policy_key,'')))=0 then
    raise exception 'AGENT_OUTBOUND_POLICY_KEY_REQUIRED';
  end if;
  if p_policy_version is null or p_policy_version<1 then
    raise exception 'AGENT_OUTBOUND_POLICY_VERSION_INVALID';
  end if;
  if p_message_kind not in ('text','template') then
    raise exception 'AGENT_OUTBOUND_MESSAGE_KIND_INVALID';
  end if;
  if p_max_followups is null or p_max_followups<0 or p_max_followups>100 then
    raise exception 'AGENT_OUTBOUND_MAX_FOLLOWUPS_INVALID';
  end if;
  if p_minimum_interval_minutes is null
     or p_minimum_interval_minutes<0
     or p_maximum_interval_minutes is null
     or p_maximum_interval_minutes<p_minimum_interval_minutes
     or p_maximum_interval_minutes>525600 then
    raise exception 'AGENT_OUTBOUND_FOLLOWUP_INTERVAL_INVALID';
  end if;
  if jsonb_typeof(v_params)<>'array' then
    raise exception 'AGENT_OUTBOUND_TEMPLATE_PARAMS_INVALID';
  end if;

  select * into v_run
  from public.ai_agent_runs
  where id=p_run_id
  for update;

  if v_run.id is null
     or v_run.run_mode<>'outbound'
     or v_run.status<>'claimed'
     or v_run.task_id is null
     or v_run.task_target_id is null then
    return jsonb_build_object('reserved',false,'reason','run_not_outbound');
  end if;

  select * into v_task
  from public.ai_agent_tasks
  where id=v_run.task_id
    and account_id=v_run.account_id
  for update;

  if v_task.id is null or v_task.status<>'running' then
    return jsonb_build_object('reserved',false,'reason','task_not_running');
  end if;

  select * into v_target
  from public.ai_agent_task_targets
  where id=v_run.task_target_id
    and account_id=v_run.account_id
    and task_id=v_run.task_id
  for update;

  if v_target.id is null or v_target.status<>'in_progress' then
    return jsonb_build_object('reserved',false,'reason','target_not_in_progress');
  end if;

  select * into v_existing
  from public.ai_agent_task_outbound_messages
  where run_id=v_run.id
  limit 1;

  if v_existing.id is not null then
    return jsonb_build_object(
      'reserved',true,
      'reason','existing',
      'reservation_id',v_existing.id,
      'status',v_existing.status,
      'message_kind',v_existing.message_kind,
      'session_window_active',v_existing.session_window_active
    );
  end if;

  if exists (
    select 1
    from public.ai_outreach_contact_controls as control
    where control.account_id=v_run.account_id
      and control.contact_id=v_target.contact_id
      and control.channel=v_task.channel
      and control.state in ('opted_out','blocked')
      and (control.suppressed_until is null or control.suppressed_until>now())
  ) then
    return jsonb_build_object('reserved',false,'reason','suppressed');
  end if;

  if p_stop_on_reply and v_target.replied_at is not null then
    return jsonb_build_object('reserved',false,'reason','reply_stop');
  end if;

  v_followup_number:=greatest(v_target.attempt_count-1,0);
  if v_followup_number>p_max_followups then
    return jsonb_build_object('reserved',false,'reason','followup_limit');
  end if;

  select max(sent_at) into v_last_sent_at
  from public.ai_agent_task_outbound_messages
  where account_id=v_run.account_id
    and task_id=v_run.task_id
    and task_target_id=v_run.task_target_id
    and status='sent';

  if v_last_sent_at is not null then
    if now()<v_last_sent_at+make_interval(mins=>p_minimum_interval_minutes) then
      return jsonb_build_object('reserved',false,'reason','followup_too_early');
    end if;
    if p_maximum_interval_minutes>0
       and now()>v_last_sent_at+make_interval(mins=>p_maximum_interval_minutes) then
      return jsonb_build_object('reserved',false,'reason','followup_window_expired');
    end if;
  end if;

  select max(message.created_at) into v_last_inbound_at
  from public.messages as message
  where message.conversation_id=v_target.conversation_id
    and message.sender_type='customer';

  v_session_active:=(
    v_last_inbound_at is not null
    and v_last_inbound_at>=now()-interval '24 hours'
  );

  if p_message_kind='text' then
    if length(btrim(coalesce(p_candidate_text,'')))=0 then
      raise exception 'AGENT_OUTBOUND_TEXT_REQUIRED';
    end if;
    if not v_session_active AND NOT public.openwa_agent_phone_call_authorized(
      v_run.account_id, v_run.provider_connection_id,
      v_target.contact_id, v_target.conversation_id
    ) then
      return jsonb_build_object('reserved',false,'reason','template_required');
    end if;
  else
    if length(btrim(coalesce(p_template_name,'')))=0
       or length(btrim(coalesce(p_template_language,'')))=0 then
      raise exception 'AGENT_OUTBOUND_TEMPLATE_REQUIRED';
    end if;

    if not exists (
      select 1
      from public.message_templates as template
      where template.account_id=v_run.account_id
        and template.name=p_template_name
        and lower(coalesce(template.language,''))=lower(p_template_language)
        and upper(coalesce(template.status,''))='APPROVED'
    ) then
      return jsonb_build_object('reserved',false,'reason','template_not_approved');
    end if;
  end if;

  v_idempotency_key:=
    'task:'||v_run.task_id::text||
    ':target:'||v_run.task_target_id::text||
    ':attempt:'||v_target.attempt_count::text;

  insert into public.ai_agent_task_outbound_messages (
    account_id,task_id,task_target_id,run_id,attempt_number,
    policy_key,policy_version,message_kind,candidate_text,
    template_name,template_language,template_params,
    session_window_active,session_last_inbound_at,status,idempotency_key
  ) values (
    v_run.account_id,v_run.task_id,v_run.task_target_id,v_run.id,
    v_target.attempt_count,p_policy_key,p_policy_version,p_message_kind,
    case when p_message_kind='text' then btrim(p_candidate_text) else p_candidate_text end,
    case when p_message_kind='template' then p_template_name else null end,
    case when p_message_kind='template' then p_template_language else null end,
    v_params,v_session_active,v_last_inbound_at,'reserved',v_idempotency_key
  )
  on conflict (idempotency_key) do nothing
  returning id into v_reservation_id;

  if v_reservation_id is null then
    select id into v_reservation_id
    from public.ai_agent_task_outbound_messages
    where idempotency_key=v_idempotency_key;
  end if;

  perform public.append_agent_task_event(
    v_run.account_id,v_run.task_id,v_run.task_target_id,v_run.id,
    'message.reserved','service',p_policy_key,
    jsonb_build_object(
      'reservation_id',v_reservation_id,
      'message_kind',p_message_kind,
      'attempt',v_target.attempt_count,
      'session_window_active',v_session_active,
      'policy_version',p_policy_version
    )
  );

  return jsonb_build_object(
    'reserved',true,
    'reason','reserved',
    'reservation_id',v_reservation_id,
    'status','reserved',
    'message_kind',p_message_kind,
    'session_window_active',v_session_active,
    'idempotency_key',v_idempotency_key
  );
end;
$function$;

-- Re-apply claim_agent_task_outbound_message with a strictly scoped OpenWA consent alternative.
CREATE OR REPLACE FUNCTION public.claim_agent_task_outbound_message(p_reservation_id uuid, p_worker_id text, p_lease_secs integer DEFAULT 120)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.ai_agent_task_outbound_messages%rowtype;
  v_task public.ai_agent_tasks%rowtype;
  v_target public.ai_agent_task_targets%rowtype;
  v_last_inbound_at timestamptz;
begin
  if length(btrim(coalesce(p_worker_id,'')))=0 then
    raise exception 'AGENT_OUTBOUND_WORKER_ID_REQUIRED';
  end if;
  if p_lease_secs<1 or p_lease_secs>3600 then
    raise exception 'AGENT_OUTBOUND_LEASE_INVALID';
  end if;

  select * into v_row
  from public.ai_agent_task_outbound_messages
  where id=p_reservation_id
  for update;

  if v_row.id is null then
    return jsonb_build_object('claimed',false,'reason','not_found');
  end if;

  if v_row.status='sent' then
    return jsonb_build_object(
      'claimed',false,'reason','already_sent',
      'local_message_id',v_row.local_message_id,
      'whatsapp_message_id',v_row.whatsapp_message_id
    );
  end if;

  if v_row.status in ('sending','requires_reconciliation') then
    return jsonb_build_object('claimed',false,'reason','reconciliation_required');
  end if;

  if v_row.status<>'reserved' then
    return jsonb_build_object('claimed',false,'reason',v_row.status);
  end if;

  select * into v_task
  from public.ai_agent_tasks
  where id=v_row.task_id
    and account_id=v_row.account_id
  for update;

  if v_task.status='cancelled' then
    update public.ai_agent_task_outbound_messages
    set status='cancelled',error_code='TASK_CANCELLED'
    where id=v_row.id;

    return jsonb_build_object('claimed',false,'reason','task_cancelled');
  end if;

  if v_task.id is null or v_task.status<>'running' then
    return jsonb_build_object('claimed',false,'reason','task_not_running');
  end if;

  select * into v_target
  from public.ai_agent_task_targets
  where id=v_row.task_target_id
    and account_id=v_row.account_id
    and task_id=v_row.task_id
  for update;

  if v_target.id is null or v_target.status<>'in_progress' then
    return jsonb_build_object('claimed',false,'reason','target_not_in_progress');
  end if;

  if exists (
    select 1
    from public.ai_outreach_contact_controls as control
    where control.account_id=v_row.account_id
      and control.contact_id=v_target.contact_id
      and control.channel=v_task.channel
      and control.state in ('opted_out','blocked')
      and (control.suppressed_until is null or control.suppressed_until>now())
  ) then
    update public.ai_agent_task_outbound_messages
    set status='cancelled',error_code='TARGET_SUPPRESSED'
    where id=v_row.id;

    return jsonb_build_object('claimed',false,'reason','suppressed');
  end if;

  if v_row.message_kind='text' then
    select max(message.created_at) into v_last_inbound_at
    from public.messages as message
    where message.conversation_id=v_target.conversation_id
      and message.sender_type='customer';

    if (v_last_inbound_at is null
       or v_last_inbound_at<now()-interval '24 hours')
       and not public.openwa_agent_phone_call_authorized(
         v_row.account_id, v_row.connection_id,
         v_target.contact_id, v_target.conversation_id
       ) then
      update public.ai_agent_task_outbound_messages
      set status='failed',error_code='SESSION_WINDOW_CLOSED'
      where id=v_row.id;

      return jsonb_build_object('claimed',false,'reason','template_required');
    end if;
  elsif not exists (
    select 1
    from public.message_templates as template
    where template.account_id=v_row.account_id
      and template.name=v_row.template_name
      and lower(coalesce(template.language,''))=lower(v_row.template_language)
      and upper(coalesce(template.status,''))='APPROVED'
  ) then
    update public.ai_agent_task_outbound_messages
    set status='failed',error_code='TEMPLATE_NOT_APPROVED'
    where id=v_row.id;

    return jsonb_build_object('claimed',false,'reason','template_not_approved');
  end if;

  update public.ai_agent_task_outbound_messages
  set status='sending',
      claimed_by=p_worker_id,
      lease_expires_at=now()+make_interval(secs=>p_lease_secs)
  where id=v_row.id;

  return jsonb_build_object(
    'claimed',true,
    'reason','claimed',
    'reservation_id',v_row.id
  );
end;
$function$;

-- Re-apply reserve_bound_agent_task_outbound_message with a strictly scoped OpenWA consent alternative.
CREATE OR REPLACE FUNCTION public.reserve_bound_agent_task_outbound_message(p_run_id uuid, p_policy_key text, p_policy_version integer, p_message_kind text, p_candidate_text text, p_template_name text, p_template_language text, p_template_params jsonb, p_max_followups integer, p_minimum_interval_minutes integer, p_maximum_interval_minutes integer, p_stop_on_reply boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_run public.ai_agent_runs%ROWTYPE;
  v_task public.ai_agent_tasks%ROWTYPE;
  v_target public.ai_agent_task_targets%ROWTYPE;
  v_connection public.whatsapp_connections%ROWTYPE;
  v_outbound public.ai_agent_task_outbound_messages%ROWTYPE;
  v_result jsonb;
  v_raw text;
  v_connection_id uuid;
BEGIN
  SELECT * INTO v_run FROM public.ai_agent_runs
    WHERE id=p_run_id FOR UPDATE;
  IF v_run.id IS NULL OR v_run.run_mode<>'outbound'
     OR v_run.status<>'claimed' OR v_run.task_id IS NULL
     OR v_run.task_target_id IS NULL THEN
    RETURN jsonb_build_object('reserved',false,'reason','run_not_outbound');
  END IF;

  SELECT * INTO v_task FROM public.ai_agent_tasks
    WHERE account_id=v_run.account_id AND id=v_run.task_id FOR UPDATE;
  SELECT * INTO v_target FROM public.ai_agent_task_targets
    WHERE account_id=v_run.account_id AND task_id=v_run.task_id
      AND id=v_run.task_target_id FOR UPDATE;
  IF v_task.id IS NULL OR v_target.id IS NULL
     OR v_target.conversation_id IS NULL OR v_target.contact_id IS NULL THEN
    RETURN jsonb_build_object('reserved',false,'reason','target_context_missing');
  END IF;

  IF v_task.target_policy ? 'whatsappConnectionId' THEN
    IF jsonb_typeof(v_task.target_policy->'whatsappConnectionId')<>'string' THEN
      RETURN jsonb_build_object('reserved',false,'reason','connection_selection_invalid');
    END IF;
    v_raw:=v_task.target_policy->>'whatsappConnectionId';
    BEGIN
      v_connection_id:=v_raw::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN jsonb_build_object('reserved',false,'reason','connection_selection_invalid');
    END;
  ELSE
    SELECT m.connection_id INTO v_connection_id FROM public.messages m
      WHERE m.conversation_id=v_target.conversation_id
        AND m.sender_type='customer'
      ORDER BY m.created_at DESC NULLS LAST, m.id DESC
      LIMIT 1;
  END IF;

  IF v_connection_id IS NULL THEN
    RETURN jsonb_build_object('reserved',false,'reason','connection_selection_required');
  END IF;

  SELECT * INTO v_connection FROM public.whatsapp_connections
    WHERE id=v_connection_id AND account_id=v_run.account_id FOR SHARE;
  IF v_connection.id IS NULL THEN
    RETURN jsonb_build_object('reserved',false,'reason','connection_not_found');
  END IF;
  IF v_connection.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('reserved',false,'reason','connection_archived');
  END IF;
  IF NOT (
    (v_connection.provider='meta_cloud' AND v_connection.status='connected')
    OR (v_connection.provider='openwa'
        AND v_connection.status IN ('ready','connected')
        AND v_connection.session_id IS NOT NULL)
  ) THEN
    RETURN jsonb_build_object('reserved',false,'reason','connection_not_ready');
  END IF;

  -- A Meta template cannot silently become an OpenWA text send.
  IF p_message_kind='template' AND v_connection.provider<>'meta_cloud' THEN
    RETURN jsonb_build_object('reserved',false,'reason','provider_template_unsupported');
  END IF;

  -- Session windows are connection-scoped. An inbound on Meta (or a different
  -- OpenWA session) must never authorize text from the selected connection.
  IF p_message_kind='text' AND NOT EXISTS (
    SELECT 1 FROM public.messages m
    WHERE m.conversation_id=v_target.conversation_id
      AND m.sender_type='customer'
      AND m.connection_id=v_connection.id
      AND m.created_at>=now()-interval '24 hours'
  ) AND NOT public.openwa_agent_phone_call_authorized(
    v_run.account_id, v_connection.id,
    v_target.contact_id, v_target.conversation_id
  ) THEN
    RETURN jsonb_build_object('reserved',false,'reason','connection_session_window_closed');
  END IF;

  v_result:=public.reserve_agent_task_outbound_message(
    p_run_id,p_policy_key,p_policy_version,p_message_kind,p_candidate_text,
    p_template_name,p_template_language,p_template_params,p_max_followups,
    p_minimum_interval_minutes,p_maximum_interval_minutes,p_stop_on_reply
  );
  IF coalesce((v_result->>'reserved')::boolean,false)<>true THEN
    RETURN v_result;
  END IF;

  SELECT * INTO v_outbound FROM public.ai_agent_task_outbound_messages
    WHERE id=(v_result->>'reservation_id')::uuid
      AND account_id=v_run.account_id FOR UPDATE;
  IF v_outbound.id IS NULL OR v_outbound.run_id<>p_run_id THEN
    RETURN jsonb_build_object('reserved',false,'reason','reservation_run_mismatch');
  END IF;
  IF v_outbound.connection_id IS NULL THEN
    IF v_outbound.status<>'reserved' THEN
      RETURN jsonb_build_object('reserved',false,'reason','unbound_prior_outcome');
    END IF;
    UPDATE public.ai_agent_task_outbound_messages
      SET provider=v_connection.provider, connection_id=v_connection.id
      WHERE id=v_outbound.id AND account_id=v_run.account_id
      RETURNING * INTO v_outbound;
  END IF;
  IF v_outbound.connection_id IS DISTINCT FROM v_connection.id
     OR v_outbound.provider IS DISTINCT FROM v_connection.provider THEN
    RETURN jsonb_build_object('reserved',false,'reason','reservation_transport_mismatch');
  END IF;
  RETURN v_result || jsonb_build_object(
    'provider',v_connection.provider,'connection_id',v_connection.id
  );
END $function$;

-- Re-apply claim_bound_agent_task_outbound_message with a strictly scoped OpenWA consent alternative.
CREATE OR REPLACE FUNCTION public.claim_bound_agent_task_outbound_message(p_reservation_id uuid, p_worker_id text, p_lease_secs integer DEFAULT 120)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_outbound public.ai_agent_task_outbound_messages%ROWTYPE;
  v_target public.ai_agent_task_targets%ROWTYPE;
  v_connection public.whatsapp_connections%ROWTYPE;
BEGIN
  SELECT * INTO v_outbound FROM public.ai_agent_task_outbound_messages
    WHERE id=p_reservation_id FOR UPDATE;
  IF v_outbound.id IS NULL THEN
    RETURN jsonb_build_object('claimed',false,'reason','not_found');
  END IF;
  IF v_outbound.status<>'reserved' THEN
    RETURN public.claim_agent_task_outbound_message(
      p_reservation_id,p_worker_id,p_lease_secs
    );
  END IF;
  IF v_outbound.connection_id IS NULL OR v_outbound.provider IS NULL THEN
    RETURN jsonb_build_object('claimed',false,'reason','connection_unbound');
  END IF;
  SELECT * INTO v_connection FROM public.whatsapp_connections
    WHERE account_id=v_outbound.account_id
      AND id=v_outbound.connection_id FOR SHARE;
  IF v_connection.id IS NULL
     OR v_connection.provider IS DISTINCT FROM v_outbound.provider THEN
    RETURN jsonb_build_object('claimed',false,'reason','connection_mismatch');
  END IF;
  IF v_connection.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('claimed',false,'reason','connection_archived');
  END IF;
  IF NOT (
    (v_connection.provider='meta_cloud' AND v_connection.status='connected')
    OR (v_connection.provider='openwa'
        AND v_connection.status IN ('ready','connected')
        AND v_connection.session_id IS NOT NULL)
  ) THEN
    RETURN jsonb_build_object('claimed',false,'reason','connection_not_ready');
  END IF;
  IF v_outbound.message_kind='template' AND v_connection.provider<>'meta_cloud' THEN
    RETURN jsonb_build_object('claimed',false,'reason','provider_template_unsupported');
  END IF;
  IF v_outbound.message_kind='text' THEN
    SELECT * INTO v_target FROM public.ai_agent_task_targets
      WHERE id=v_outbound.task_target_id
        AND account_id=v_outbound.account_id
        AND task_id=v_outbound.task_id;
    IF v_target.conversation_id IS NULL OR (NOT EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.conversation_id=v_target.conversation_id
        AND m.sender_type='customer'
        AND m.connection_id=v_outbound.connection_id
        AND m.created_at>=now()-interval '24 hours'
    ) AND NOT public.openwa_agent_phone_call_authorized(
      v_outbound.account_id, v_connection.id,
      v_target.contact_id, v_target.conversation_id
    )) THEN
      RETURN jsonb_build_object('claimed',false,'reason','connection_session_window_closed');
    END IF;
  END IF;
  RETURN public.claim_agent_task_outbound_message(
    p_reservation_id,p_worker_id,p_lease_secs
  );
END $function$;
