begin;

do $$
declare
  v_user uuid := '00000000-0000-4000-8000-000000000127';
  v_account uuid;
  v_connection uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_revision uuid := gen_random_uuid();
  v_task uuid := gen_random_uuid();
  v_contact_1 uuid := gen_random_uuid();
  v_contact_2 uuid := gen_random_uuid();
  v_conv_1 uuid := gen_random_uuid();
  v_conv_2 uuid := gen_random_uuid();
  v_target_1 uuid := gen_random_uuid();
  v_target_2 uuid := gen_random_uuid();
  v_run_1 uuid;
  v_run_2 uuid;
  v_run_3 uuid;
  v_result text;
  v_json jsonb;
  v_target_guarded boolean := false;
  v_message_guarded boolean := false;
begin
  insert into auth.users(id,email,raw_user_meta_data)
  values (
    v_user,
    'agent-task-guardrails-smoke@example.test',
    '{"full_name":"Agent Task Guardrails Smoke"}'::jsonb
  );

  select account_id into strict v_account
  from public.profiles
  where user_id=v_user;

  insert into public.ai_provider_connections(
    id,account_id,name,preset_id,protocol,api_root,
    encrypted_api_key,connection_fingerprint,status
  ) values (
    v_connection,v_account,'Guardrails Provider','guardrails-smoke',
    'openai','https://example.test/v1','encrypted-smoke-key',
    'guardrails-smoke-127','verified'
  );

  insert into public.ai_agents(
    id,account_id,slug,name,purpose,status
  ) values (
    v_agent,v_account,'guardrails-agent',
    'Guardrails Agent','custom','active'
  );

  insert into public.ai_agent_revisions(
    id,account_id,agent_id,revision_number,status,
    provider_connection_id,model
  ) values (
    v_revision,v_account,v_agent,1,'published',
    v_connection,'guardrails-model'
  );

  update public.ai_agents
  set published_revision_id=v_revision
  where id=v_agent;

  insert into public.contacts(id,user_id,account_id,phone,name)
  values
    (v_contact_1,v_user,v_account,'+967700000127','Guardrails One'),
    (v_contact_2,v_user,v_account,'+967700000128','Guardrails Two');

  insert into public.conversations(id,user_id,account_id,contact_id)
  values
    (v_conv_1,v_user,v_account,v_contact_1),
    (v_conv_2,v_user,v_account,v_contact_2);

  insert into public.messages(
    conversation_id,sender_type,content_type,content_text,status,created_at
  ) values
    (v_conv_1,'customer','text','recent inbound one','sent',now()),
    (v_conv_2,'customer','text','recent inbound two','sent',now());

  insert into public.ai_runtime_policies(
    account_id,multi_agent_enabled,admin_plane_enabled,
    native_tools_enabled,proposal_tools_enabled,recovery_worker_enabled,
    outbound_task_delivery_enabled,kill_switch,max_runs_per_minute,
    daily_message_budget,daily_estimated_provider_cost_micros,
    updated_by
  ) values (
    v_account,true,true,true,true,true,true,false,100,
    10,1000,v_user
  )
  on conflict (account_id) do update set
    multi_agent_enabled=true,
    admin_plane_enabled=true,
    native_tools_enabled=true,
    proposal_tools_enabled=true,
    recovery_worker_enabled=true,
    outbound_task_delivery_enabled=true,
    kill_switch=false,
    max_runs_per_minute=100,
    daily_message_budget=10,
    daily_estimated_provider_cost_micros=1000,
    updated_by=v_user;

  insert into public.ai_agent_tasks(
    id,account_id,task_type,task_type_version,agent_id,agent_revision_id,
    trigger_type,status,objective,task_context,target_policy,channel,
    max_targets,max_attempts_per_target,budget_policy,
    idempotency_key,correlation_id,created_by
  ) values (
    v_task,v_account,'coverage.sourcing',1,v_agent,v_revision,
    'manual','running','Guardrail smoke task','{}'::jsonb,'{}'::jsonb,
    'whatsapp',10,5,
    jsonb_build_object(
      'dailyTokenBudget',1000,
      'dailyMessageBudget',1,
      'dailyEstimatedProviderCostMicros',1000
    ),
    'guardrails-task-127','guardrails-correlation-127',v_user
  );

  insert into public.ai_agent_task_targets(
    id,account_id,task_id,contact_id,counterparty_role,status,
    conversation_id,attempt_count,idempotency_key
  ) values (
    v_target_1,v_account,v_task,v_contact_1,'supplier','in_progress',
    v_conv_1,1,'guardrails-target-1-127'
  );

  v_run_1:=public.create_agent_execution(
    v_account,v_conv_1,null,v_agent,v_revision,v_connection,
    null,'guardrails smoke','customer','outbound',
    v_task,v_target_1,'task_target','attempt:1','supplier',
    'guardrails-run-1-127'
  );
  if public.claim_agent_run(v_run_1,'guardrails-worker',300)<>'claimed' then
    raise exception 'guardrails run 1 claim failed';
  end if;

  -- Monetary budgets fail closed until an exact account/provider/model rate exists.
  v_result:=public.reserve_ai_agent_runtime_budget(
    v_account,v_run_1,100,100
  );
  if v_result<>'PROVIDER_COST_RATE_REQUIRED' then
    raise exception 'cost budget did not require a rate: %',v_result;
  end if;

  insert into public.ai_provider_model_cost_rates(
    account_id,provider_connection_id,model,
    input_micros_per_million_tokens,
    output_micros_per_million_tokens,
    created_by
  ) values (
    v_account,v_connection,'guardrails-model',
    1000000,1000000,v_user
  );

  v_result:=public.reserve_ai_agent_runtime_budget(
    v_account,v_run_1,100,100
  );
  if v_result is not null then
    raise exception 'valid runtime budget was denied: %',v_result;
  end if;

  if not exists (
    select 1 from public.ai_agent_runs
    where id=v_run_1
      and estimated_provider_cost_micros=200
      and provider_cost_rate_snapshot->>'model'='guardrails-model'
  ) then
    raise exception 'estimated provider cost snapshot missing';
  end if;

  update public.ai_agent_runs
  set input_tokens=50,output_tokens=25
  where id=v_run_1;

  if not exists (
    select 1 from public.ai_agent_runs
    where id=v_run_1 and provider_cost_micros=75
  ) then
    raise exception 'actual provider cost trigger failed';
  end if;

  raise notice 'Agent Task guardrails smoke passed';
end
$$;

rollback;
