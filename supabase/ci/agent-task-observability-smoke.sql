begin;

do $$
declare
  v_user uuid;
  v_account uuid;
  v_connection uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_revision uuid := gen_random_uuid();
  v_task uuid := gen_random_uuid();
  v_target uuid := gen_random_uuid();
  v_contact uuid := gen_random_uuid();
  v_conversation uuid := gen_random_uuid();
  v_outbound_local uuid := gen_random_uuid();
  v_inbound_reply uuid := gen_random_uuid();
  v_run_outbound uuid;
  v_run_reply uuid;
  v_intent uuid;
  v_change uuid;
  v_event uuid := gen_random_uuid();
  v_trace jsonb;
  v_metrics jsonb;
  v_now timestamptz := now();
begin
  select profile.user_id,profile.account_id
    into strict v_user,v_account
  from public.profiles as profile
  order by profile.created_at asc
  limit 1;

  insert into public.ai_provider_connections(
    id,account_id,name,preset_id,protocol,api_root,
    encrypted_api_key,connection_fingerprint,status
  ) values (
    v_connection,v_account,
    'Observability Provider '||substr(v_connection::text,1,8),
    'observability-smoke','openai','https://example.test/v1',
    'encrypted-observability-smoke',
    'observability-'||v_connection::text,'verified'
  );

  insert into public.ai_agents(
    id,account_id,slug,name,purpose,status
  ) values (
    v_agent,v_account,
    'observability-'||substr(v_agent::text,1,8),
    'Observability Agent','custom','active'
  );

  insert into public.ai_agent_revisions(
    id,account_id,agent_id,revision_number,status,
    provider_connection_id,model
  ) values (
    v_revision,v_account,v_agent,1,'published',
    v_connection,'observability-model'
  );

  update public.ai_agents
  set published_revision_id=v_revision
  where id=v_agent;

  insert into public.contacts(
    id,user_id,account_id,phone,name
  ) values (
    v_contact,v_user,v_account,
    '+9677'||right(replace(v_contact::text,'-',''),8),
    'Observability Contact'
  );

  insert into public.conversations(
    id,user_id,account_id,contact_id,status
  ) values (
    v_conversation,v_user,v_account,v_contact,'open'
  );

  insert into public.ai_runtime_policies(
    account_id,multi_agent_enabled,recovery_worker_enabled,
    outbound_task_delivery_enabled,kill_switch,max_runs_per_minute,updated_by
  ) values (
    v_account,true,true,true,false,100,v_user
  )
  on conflict (account_id) do update set
    multi_agent_enabled=true,
    recovery_worker_enabled=true,
    outbound_task_delivery_enabled=true,
    kill_switch=false,
    max_runs_per_minute=100,
    updated_by=v_user;

  insert into public.ai_agent_tasks(
    id,account_id,task_type,task_type_version,
    agent_id,agent_revision_id,trigger_type,status,
    objective,task_context,target_policy,channel,
    max_targets,max_attempts_per_target,budget_policy,
    idempotency_key,correlation_id,created_by,
    started_at
  ) values (
    v_task,v_account,'services.promotion',1,
    v_agent,v_revision,'manual','running',
    'Observability smoke','{}'::jsonb,'{}'::jsonb,'whatsapp',
    5,3,'{}'::jsonb,
    'observability-task-'||v_task::text,
    'observability-correlation-'||v_task::text,
    v_user,v_now
  );

  insert into public.ai_agent_task_targets(
    id,account_id,task_id,contact_id,counterparty_role,status,
    conversation_id,attempt_count,idempotency_key,
    first_contacted_at,replied_at
  ) values (
    v_target,v_account,v_task,v_contact,'service_customer','replied',
    v_conversation,1,
    'observability-target-'||v_target::text,
    v_now,v_now
  );

  v_run_outbound:=public.create_agent_execution(
    v_account,v_conversation,null,v_agent,v_revision,v_connection,
    null,'observability smoke','customer','outbound',
    v_task,v_target,'task_target','attempt:1','service_customer',
    'observability-outbound-'||v_task::text
  );

  update public.ai_agent_runs
  set status='succeeded',
      started_at=v_now,
      completed_at=v_now,
      input_tokens=10,
      output_tokens=5,
      estimated_provider_cost_micros=20,
      provider_cost_micros=15
  where id=v_run_outbound;

  insert into public.ai_agent_tool_call_attempts(
    account_id,run_id,agent_id,revision_id,
    tool_key,tool_version,round,permission,status,
    error_code,input_hash,duration_ms
  ) values (
    v_account,v_run_outbound,v_agent,v_revision,
    'services.get',1,1,'read','failed',
    'OBSERVABILITY_SMOKE_FAILURE',
    encode(digest('SECRET_TOOL_ARGS_SENTINEL','sha256'),'hex'),
    12
  );

  insert into public.messages(
    id,conversation_id,sender_type,content_type,content_text,
    message_id,status,ai_generated,ai_agent_run_id
  ) values (
    v_outbound_local,v_conversation,'bot','text',
    'SECRET_OUTBOUND_BODY_SENTINEL',
    'wamid.observability.outbound','sent',true,v_run_outbound
  );

  insert into public.ai_agent_task_outbound_messages(
    account_id,task_id,task_target_id,run_id,attempt_number,
    policy_key,policy_version,message_kind,candidate_text,
    session_window_active,status,idempotency_key,
    local_message_id,whatsapp_message_id,sent_at
  ) values (
    v_account,v_task,v_target,v_run_outbound,1,
    'services.promotion_message',1,'text',
    'SECRET_CANDIDATE_SENTINEL',
    true,'sent',
    'observability-outbound-reservation-'||v_run_outbound::text,
    v_outbound_local,'wamid.observability.outbound',v_now
  );

  update public.ai_agent_task_targets
  set last_outbound_message_id=v_outbound_local
  where id=v_target;

  insert into public.messages(
    id,conversation_id,sender_type,content_type,content_text,
    message_id,status,reply_to_message_id,ai_generated
  ) values (
    v_inbound_reply,v_conversation,'customer','text',
    'SECRET_INBOUND_REPLY_SENTINEL',
    'wamid.observability.reply','sent',v_outbound_local,false
  );

  v_run_reply:=public.create_agent_execution(
    v_account,v_conversation,v_inbound_reply,
    v_agent,v_revision,v_connection,
    null,'task_reply:reply_context','customer','inbound',
    v_task,v_target,'task_reply','reply_context','service_customer',
    'observability-reply-'||v_task::text
  );

  update public.ai_agent_runs
  set status='succeeded',
      started_at=v_now,
      completed_at=v_now,
      input_tokens=8,
      output_tokens=4
  where id=v_run_reply;

  perform public.append_agent_task_event(
    v_account,v_task,v_target,v_run_reply,
    'target.replied','service','observability-smoke',
    jsonb_build_object(
      'inbound_message_id',v_inbound_reply,
      'reply_to_message_id',v_outbound_local,
      'correlation_method','reply_context'
    )
  );

  select public.create_customer_intent(
    v_account,
    v_contact,
    v_conversation,
    'request',
    'observability-service',
    'SECRET_INTENT_SUMMARY_SENTINEL',
    '{}'::jsonb,
    'observability-intent-'||v_run_reply::text,
    v_user
  ) into v_intent;

  perform public.link_ai_agent_business_outcome(
    v_account,v_run_reply,'customer_intent',v_intent::text,'new'
  );

  select id into v_change
  from public.create_change_request_v3(
    v_account,
    'intents.decision.apply',
    1,
    'service_intent',
    v_intent,
    'update',
    '{"decision":"matched"}'::jsonb,
    null,
    'observability-change-'||v_run_reply::text,
    'Observability change',
    v_user
  );

  update public.change_requests
  set source_run_id=v_run_reply
  where account_id=v_account
    and id=v_change;

  insert into public.business_event_outbox(
    id,account_id,event_type,event_version,
    subject_type,subject_id,audience,channel,
    contact_id,conversation_id,correlation_id,causation_id,
    payload,delivery_mode,status,dedupe_key
  ) values (
    v_event,v_account,'service_request.matched',1,
    'service_intent',v_intent::text,'customer','whatsapp',
    v_contact,v_conversation,v_change::text,v_intent::text,
    '{"safe":"metadata"}'::jsonb,'shadow','pending',
    'observability-business-event-'||v_event::text
  );

  perform public.record_ai_agent_circuit_event_v2(
    v_account,'provider',v_connection::text,'failure',
    'OBSERVABILITY_PROVIDER_FAILURE',
    v_run_reply,v_task
  );

  perform public.append_agent_task_event(
    v_account,v_task,v_target,v_run_reply,
    'target.paused_for_human','service','observability-smoke',
    '{"reason":"smoke"}'::jsonb
  );

  v_trace:=public.inspect_ai_agent_task_trace(v_account,v_task);

  if v_trace is null
     or jsonb_array_length(v_trace->'targets')<1
     or jsonb_array_length(v_trace->'runs')<2
     or jsonb_array_length(v_trace->'tool_calls')<1
     or jsonb_array_length(v_trace->'outbound_messages')<1
     or jsonb_array_length(v_trace->'replies')<1
     or jsonb_array_length(v_trace->'change_requests')<1
     or jsonb_array_length(v_trace->'business_outcomes')<2
     or jsonb_array_length(v_trace->'circuit_events')<1 then
    raise exception 'Observability trace is incomplete: %',v_trace;
  end if;

  if v_trace::text like '%SECRET_OUTBOUND_BODY_SENTINEL%'
     or v_trace::text like '%SECRET_CANDIDATE_SENTINEL%'
     or v_trace::text like '%SECRET_INBOUND_REPLY_SENTINEL%'
     or v_trace::text like '%SECRET_INTENT_SUMMARY_SENTINEL%'
     or v_trace::text like '%SECRET_TOOL_ARGS_SENTINEL%' then
    raise exception 'Observability trace leaked redacted content';
  end if;

  v_metrics:=public.inspect_ai_agent_task_metrics(
    v_account,
    v_now-interval '1 minute',
    v_now+interval '1 minute'
  );

  if coalesce((v_metrics->>'tasks_started')::bigint,0)<1
     or coalesce((v_metrics->>'targets_selected')::bigint,0)<1
     or coalesce((v_metrics->>'contacts_reached')::bigint,0)<1
     or coalesce((v_metrics->>'replies')::bigint,0)<1
     or coalesce((v_metrics->>'positive_replies')::bigint,0)<1
     or coalesce((v_metrics->>'business_outcomes')::bigint,0)<2
     or coalesce((v_metrics->>'tool_failures')::bigint,0)<1
     or coalesce((v_metrics->>'provider_failures')::bigint,0)<1
     or coalesce((v_metrics->>'sent_messages')::bigint,0)<1
     or coalesce((v_metrics->>'human_handoffs')::bigint,0)<1 then
    raise exception 'Observability metrics are incomplete: %',v_metrics;
  end if;

  if v_metrics->>'message_cost_status'
       <>'authoritative_channel_billing_rate_not_configured'
     or v_metrics->'message_cost_micros' <> 'null'::jsonb then
    raise exception 'Message cost must remain explicitly unpriced: %',v_metrics;
  end if;

  if has_function_privilege(
       'anon',
       'public.inspect_ai_agent_task_trace(uuid,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.inspect_ai_agent_task_trace(uuid,uuid)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.inspect_ai_agent_task_trace(uuid,uuid)',
       'EXECUTE'
     ) then
    raise exception 'Task trace RPC privileges are unsafe';
  end if;

  raise notice 'Agent Task observability smoke passed';
end
$$;

rollback;
