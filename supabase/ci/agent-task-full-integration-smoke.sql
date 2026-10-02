begin;

do $$
declare
  v_user uuid;
  v_account uuid;
  v_connection uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_revision uuid := gen_random_uuid();
  v_task uuid := gen_random_uuid();
  v_contact uuid := gen_random_uuid();
  v_conversation uuid := gen_random_uuid();
  v_target uuid := gen_random_uuid();
  v_run uuid;
  v_reservation uuid;
  v_local_message uuid := gen_random_uuid();
  v_result jsonb;
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
    'Phase17 Integration '||substr(v_connection::text,1,8),
    'phase17-integration','openai','https://example.test/v1',
    'encrypted-phase17-integration',
    'phase17-integration-'||v_connection::text,'verified'
  );

  insert into public.ai_agents(
    id,account_id,slug,name,purpose,status
  ) values (
    v_agent,v_account,
    'phase17-integration-'||substr(v_agent::text,1,8),
    'Phase 17 Integration Agent','custom','active'
  );

  insert into public.ai_agent_revisions(
    id,account_id,agent_id,revision_number,status,
    provider_connection_id,model
  ) values (
    v_revision,v_account,v_agent,1,'published',
    v_connection,'phase17-model'
  );

  update public.ai_agents
  set published_revision_id=v_revision
  where id=v_agent;

  insert into public.contacts(
    id,user_id,account_id,phone,name
  ) values (
    v_contact,v_user,v_account,
    '+96774'||right(replace(v_contact::text,'-',''),7),
    'Phase 17 Integration Contact'
  );

  insert into public.conversations(
    id,user_id,account_id,contact_id,status
  ) values (
    v_conversation,v_user,v_account,v_contact,'open'
  );

  -- Recent inbound keeps the WhatsApp 24-hour free-form session open.
  insert into public.messages(
    conversation_id,sender_type,content_type,content_text,status,created_at
  ) values (
    v_conversation,'customer','text',
    'Phase 17 integration inbound','sent',now()
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
    idempotency_key,correlation_id,created_by,started_at
  ) values (
    v_task,v_account,'services.promotion',1,
    v_agent,v_revision,'manual','running',
    'Phase 17 integration chain',
    '{}'::jsonb,'{}'::jsonb,'whatsapp',
    5,3,'{}'::jsonb,
    'phase17-integration-task-'||v_task::text,
    'phase17-integration-correlation-'||v_task::text,
    v_user,now()
  );

  insert into public.ai_agent_task_targets(
    id,account_id,task_id,contact_id,counterparty_role,status,
    conversation_id,attempt_count,idempotency_key
  ) values (
    v_target,v_account,v_task,v_contact,
    'service_customer','in_progress',v_conversation,1,
    'phase17-integration-target-'||v_target::text
  );

  v_run:=public.create_agent_execution(
    v_account,v_conversation,null,
    v_agent,v_revision,v_connection,
    null,'phase17 integration','customer','outbound',
    v_task,v_target,'task_target','attempt:1','service_customer',
    'phase17-integration-run-'||v_task::text
  );

  if public.claim_agent_run(v_run,'phase17-integration-worker',300)
       <>'claimed' then
    raise exception 'Phase 17 run claim failed';
  end if;

  -- Tool execution itself is TypeScript-owned; the durable integration seam
  -- is its audited attempt row tied to this exact Run.
  insert into public.ai_agent_tool_call_attempts(
    account_id,run_id,agent_id,revision_id,
    tool_key,tool_version,round,permission,status,
    input_hash,duration_ms
  ) values (
    v_account,v_run,v_agent,v_revision,
    'services.get',1,1,'read','succeeded',
    encode(digest('phase17-integration-tool','sha256'),'hex'),7
  );

  v_result:=public.reserve_agent_task_outbound_message(
    v_run,
    'services.promotion_message',
    1,
    'text',
    'مرحبا، هذه رسالة اختبار تكامل محدودة.',
    null,
    null,
    '[]'::jsonb,
    2,
    60,
    1440,
    true
  );

  if coalesce((v_result->>'reserved')::boolean,false)<>true then
    raise exception 'Phase 17 outbound reservation failed: %',v_result;
  end if;

  v_reservation:=(v_result->>'reservation_id')::uuid;

  v_result:=public.claim_agent_task_outbound_message(
    v_reservation,'phase17-transport',120
  );

  if coalesce((v_result->>'claimed')::boolean,false)<>true then
    raise exception 'Phase 17 transport claim failed: %',v_result;
  end if;

  insert into public.messages(
    id,conversation_id,sender_type,content_type,content_text,
    message_id,status,ai_generated,ai_agent_run_id
  ) values (
    v_local_message,v_conversation,'bot','text',
    'مرحبا، هذه رسالة اختبار تكامل محدودة.',
    'wamid.phase17.integration','sent',true,v_run
  );

  if not public.complete_agent_task_outbound_message(
    v_reservation,
    'phase17-transport',
    v_local_message,
    'wamid.phase17.integration',
    13,
    5
  ) then
    raise exception 'Phase 17 outbound completion failed';
  end if;

  if not exists (
    select 1
    from public.ai_agent_tasks as task
    join public.ai_agent_task_targets as target
      on target.account_id=task.account_id
     and target.task_id=task.id
    join public.ai_agent_runs as run
      on run.account_id=task.account_id
     and run.task_id=task.id
     and run.task_target_id=target.id
    join public.ai_agent_tool_call_attempts as attempt
      on attempt.account_id=run.account_id
     and attempt.run_id=run.id
    join public.ai_agent_task_outbound_messages as outbound
      on outbound.account_id=task.account_id
     and outbound.run_id=run.id
    join public.messages as message
      on message.id=outbound.local_message_id
     and message.conversation_id=target.conversation_id
    where task.id=v_task
      and target.id=v_target
      and target.status='awaiting_reply'
      and run.id=v_run
      and run.status='succeeded'
      and attempt.tool_key='services.get'
      and attempt.status='succeeded'
      and outbound.id=v_reservation
      and outbound.status='sent'
      and message.id=v_local_message
      and message.message_id='wamid.phase17.integration'
  ) then
    raise exception 'Phase 17 durable integration chain is incomplete';
  end if;

  if (
    select count(*)
    from public.ai_agent_task_outbound_messages
    where account_id=v_account
      and run_id=v_run
  )<>1 then
    raise exception 'Phase 17 integration produced duplicate reservations';
  end if;

  raise notice 'Agent Task Phase 17 full integration smoke passed';
end
$$;

rollback;
