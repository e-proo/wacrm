begin;

do $$
declare
  v_user uuid;
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
  v_fail_closed boolean := false;
begin
  select profile.user_id, profile.account_id
    into strict v_user, v_account
  from public.profiles as profile
  order by profile.created_at asc
  limit 1;

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
    v_agent,v_account,'guardrails-agent-'||substr(v_agent::text,1,8),
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
    'guardrails-task-127-'||v_task::text,
    'guardrails-correlation-127-'||v_task::text,
    v_user
  );

  insert into public.ai_agent_task_targets(
    id,account_id,task_id,contact_id,counterparty_role,status,
    conversation_id,attempt_count,idempotency_key
  ) values (
    v_target_1,v_account,v_task,v_contact_1,'supplier','in_progress',
    v_conv_1,1,'guardrails-target-1-'||v_target_1::text
  );

  v_run_1:=public.create_agent_execution(
    v_account,v_conv_1,null,v_agent,v_revision,v_connection,
    null,'guardrails smoke','customer','outbound',
    v_task,v_target_1,'task_target','attempt:1','supplier',
    'guardrails-run-1-'||v_task::text
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

  perform public.release_ai_agent_runtime_budget(v_run_1);

  -- Agent pause is a hard execution switch.
  update public.ai_agents set status='paused' where id=v_agent;
  v_result:=public.reserve_ai_agent_runtime_budget(
    v_account,v_run_1,10,10
  );
  if v_result<>'AGENT_PAUSED' then
    raise exception 'paused agent was allowed: %',v_result;
  end if;
  update public.ai_agents set status='active' where id=v_agent;

  -- Task pause is a hard execution switch.
  update public.ai_agent_tasks set status='paused' where id=v_task;
  v_result:=public.reserve_ai_agent_runtime_budget(
    v_account,v_run_1,10,10
  );
  if v_result<>'TASK_NOT_RUNNING' then
    raise exception 'paused task was allowed: %',v_result;
  end if;
  update public.ai_agent_tasks set status='running' where id=v_task;

  -- Existing rate-limit override table is enforced.
  insert into public.ai_agent_rate_limit_overrides(
    account_id,agent_id,rate_window,max_requests,is_active,created_by
  ) values (
    v_account,v_agent,'minute',1,true,v_user
  );

  v_run_2:=public.create_agent_execution(
    v_account,v_conv_1,null,v_agent,v_revision,v_connection,
    null,'guardrails rate smoke','customer','outbound',
    v_task,v_target_1,'task_target','attempt:2','supplier',
    'guardrails-run-2-'||v_task::text
  );
  if public.claim_agent_run(v_run_2,'guardrails-worker',300)<>'claimed' then
    raise exception 'guardrails run 2 claim failed';
  end if;

  v_result:=public.reserve_ai_agent_runtime_budget(
    v_account,v_run_2,10,10
  );
  if v_result<>'AGENT_RATE_LIMIT_EXCEEDED:minute' then
    raise exception 'agent rate override was not enforced: %',v_result;
  end if;

  delete from public.ai_agent_rate_limit_overrides
  where account_id=v_account
    and agent_id=v_agent;

  -- Task-type and channel kill switches are enforced before provider use.
  insert into public.ai_agent_scope_controls(
    account_id,scope_type,scope_key,is_enabled,created_by
  ) values (
    v_account,'task_type','coverage.sourcing@1',false,v_user
  );

  v_result:=public.reserve_ai_agent_runtime_budget(
    v_account,v_run_2,10,10
  );
  if v_result<>'TASK_TYPE_DISABLED' then
    raise exception 'task-type switch was not enforced: %',v_result;
  end if;

  update public.ai_agent_scope_controls
  set is_enabled=true
  where account_id=v_account
    and scope_type='task_type'
    and scope_key='coverage.sourcing@1';

  insert into public.ai_agent_scope_controls(
    account_id,scope_type,scope_key,is_enabled,created_by
  ) values (
    v_account,'channel','whatsapp',false,v_user
  );

  v_result:=public.reserve_ai_agent_runtime_budget(
    v_account,v_run_2,10,10
  );
  if v_result<>'CHANNEL_DISABLED' then
    raise exception 'channel switch was not enforced: %',v_result;
  end if;

  update public.ai_agent_scope_controls
  set is_enabled=true,daily_target_limit=1
  where account_id=v_account
    and scope_type='channel'
    and scope_key='whatsapp';

  -- Channel target cap rejects the second target transactionally.
  begin
    insert into public.ai_agent_task_targets(
      id,account_id,task_id,contact_id,counterparty_role,status,
      conversation_id,attempt_count,idempotency_key
    ) values (
      v_target_2,v_account,v_task,v_contact_2,'supplier','in_progress',
      v_conv_2,1,'guardrails-target-2-'||v_target_2::text
    );
  exception when others then
    if position(
      'AGENT_CHANNEL_DAILY_TARGET_LIMIT_EXCEEDED' in upper(sqlerrm)
    )>0 then
      v_target_guarded:=true;
    else
      raise;
    end if;
  end;

  if not v_target_guarded then
    raise exception 'channel daily target limit was not enforced';
  end if;

  update public.ai_agent_scope_controls
  set daily_target_limit=null
  where account_id=v_account
    and scope_type='channel'
    and scope_key='whatsapp';

  insert into public.ai_agent_task_targets(
    id,account_id,task_id,contact_id,counterparty_role,status,
    conversation_id,attempt_count,idempotency_key
  ) values (
    v_target_2,v_account,v_task,v_contact_2,'supplier','in_progress',
    v_conv_2,1,'guardrails-target-2-'||v_target_2::text
  );

  -- First outbound reservation consumes the task one-message daily budget.
  v_json:=public.reserve_agent_task_outbound_message(
    v_run_1,'coverage.sourcing_message',1,'text',
    'Guardrails first message.',null,null,'[]'::jsonb,
    1,0,1440,true
  );
  if coalesce((v_json->>'reserved')::boolean,false)<>true then
    raise exception 'first guarded message was not reserved: %',v_json;
  end if;

  v_run_3:=public.create_agent_execution(
    v_account,v_conv_2,null,v_agent,v_revision,v_connection,
    null,'guardrails message smoke','customer','outbound',
    v_task,v_target_2,'task_target','attempt:1','supplier',
    'guardrails-run-3-'||v_task::text
  );
  if public.claim_agent_run(v_run_3,'guardrails-worker',300)<>'claimed' then
    raise exception 'guardrails run 3 claim failed';
  end if;

  begin
    v_json:=public.reserve_agent_task_outbound_message(
      v_run_3,'coverage.sourcing_message',1,'text',
      'Guardrails second message.',null,null,'[]'::jsonb,
      1,0,1440,true
    );
  exception when others then
    if position(
      'TASK_DAILY_MESSAGE_BUDGET_EXCEEDED' in upper(sqlerrm)
    )>0 then
      v_message_guarded:=true;
    else
      raise;
    end if;
  end;

  if not v_message_guarded then
    raise exception 'task daily message budget was not enforced';
  end if;

  -- Account provider-cost cap includes the current reservation estimate.
  update public.ai_runtime_policies
  set daily_estimated_provider_cost_micros=100
  where account_id=v_account;

  v_result:=public.reserve_ai_agent_runtime_budget(
    v_account,v_run_2,100,100
  );
  if v_result<>'DAILY_PROVIDER_COST_BUDGET_EXCEEDED' then
    raise exception 'account provider cost budget was not enforced: %',v_result;
  end if;

  -- Circuit opens at threshold, blocks, then closes after cooldown expiry.
  insert into public.ai_agent_circuit_breakers(
    account_id,scope_type,scope_key,
    failure_threshold,rejection_threshold,
    window_seconds,cooldown_seconds,created_by
  ) values (
    v_account,'provider',v_connection::text,
    2,3,300,30,v_user
  );

  v_json:=public.record_ai_agent_circuit_event(
    v_account,'provider',v_connection::text,'failure','SMOKE_FAILURE_1'
  );
  if coalesce((v_json->>'open')::boolean,false) then
    raise exception 'provider circuit opened too early: %',v_json;
  end if;

  v_json:=public.record_ai_agent_circuit_event(
    v_account,'provider',v_connection::text,'failure','SMOKE_FAILURE_2'
  );
  if coalesce((v_json->>'open')::boolean,false)<>true then
    raise exception 'provider circuit did not open: %',v_json;
  end if;

  v_json:=public.check_ai_agent_circuit_breaker(
    v_account,'provider',v_connection::text
  );
  if coalesce((v_json->>'open')::boolean,false)<>true then
    raise exception 'open provider circuit was not observable: %',v_json;
  end if;

  update public.ai_agent_circuit_breakers
  set blocked_until=now()-interval '1 second'
  where account_id=v_account
    and scope_type='provider'
    and scope_key=v_connection::text;

  v_json:=public.check_ai_agent_circuit_breaker(
    v_account,'provider',v_connection::text
  );
  if coalesce((v_json->>'open')::boolean,false) then
    raise exception 'expired provider circuit did not close: %',v_json;
  end if;

  -- Reservation is fail-closed even when a caller bypasses the worker.
  delete from public.ai_runtime_policies where account_id=v_account;

  begin
    v_json:=public.reserve_agent_task_outbound_message(
      v_run_3,'coverage.sourcing_message',1,'text',
      'This must be rejected by the DB gate.',null,null,'[]'::jsonb,
      1,0,1440,true
    );
  exception when others then
    if position('OUTBOUND_TASK_DELIVERY_DISABLED' in upper(sqlerrm))>0 then
      v_fail_closed:=true;
    else
      raise;
    end if;
  end;

  if not v_fail_closed then
    raise exception 'outbound reservation was not fail-closed without policy';
  end if;

  if has_function_privilege(
       'anon',
       'public.record_ai_agent_circuit_event(uuid,text,text,text,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.record_ai_agent_circuit_event(uuid,text,text,text,text)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.record_ai_agent_circuit_event(uuid,text,text,text,text)',
       'EXECUTE'
     ) then
    raise exception 'circuit event RPC privileges are unsafe';
  end if;

  raise notice 'Agent Task guardrails smoke passed';
end
$$;

rollback;
