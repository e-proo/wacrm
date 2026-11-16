-- SOF-66: fix the SQL reservation layer's OpenWA telephone-consent
-- gate, which accidentally passed ai_agent_runs.provider_connection_id
-- (AI MODEL credentials) where a whatsapp_connections.id was required.
--
-- This is additive: never modify already-applied migration 166.
-- The existing function's policy, opt-out, window, template, quota,
-- idempotency, RLS, and Meta behavior are unchanged except this exact gate.
-- This migration performs no reservations, send attempts or Task resets.
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
  -- The Run's provider_connection_id is an AI MODEL provider identifier.
  -- For explicit OpenWA telephone consent, use ONLY the WhatsApp transport
  -- connection explicitly frozen on this account-scoped Task.
  v_selected_whatsapp_connection uuid;
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
    if not v_session_active then
      -- Keep Meta's 24h/template rule unchanged. Only a pinned, account-
      -- scoped OpenWA session may satisfy this alternate TEST consent path.
      -- The helper checks session state, tenant, exact recipient hash, expiry,
      -- phone-call attestation, Pilot pause and circuit safety again.
      if jsonb_typeof(v_task.target_policy->'whatsappConnectionId')='string' then
        begin
          v_selected_whatsapp_connection :=
            (v_task.target_policy->>'whatsappConnectionId')::uuid;
        exception when invalid_text_representation then
          v_selected_whatsapp_connection:=NULL;
        end;
      end if;

      if v_selected_whatsapp_connection is null
         or not public.openwa_agent_phone_call_authorized(
           v_run.account_id, v_selected_whatsapp_connection,
           v_target.contact_id, v_target.conversation_id
         ) then
        return jsonb_build_object('reserved',false,'reason','template_required');
      end if;
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
REVOKE ALL ON FUNCTION public.reserve_agent_task_outbound_message(uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_agent_task_outbound_message(uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean)
  TO service_role;

COMMENT ON FUNCTION public.reserve_agent_task_outbound_message(uuid,text,integer,text,text,text,text,jsonb,integer,integer,integer,boolean)
IS 'SOF-66: explicit phone-call WhatsApp consent uses the account-scoped Task-pinned OpenWA transport, never the AI model provider ID. Existing Meta/24-hour/template and outbound idempotency policies remain in force.';
