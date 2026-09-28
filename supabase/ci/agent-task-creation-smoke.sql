do $$
declare
  v_user uuid := '00000000-0000-4000-8000-000000000119';
  v_account uuid;
  v_connection uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_revision uuid := gen_random_uuid();
  v_reactive_revision uuid := gen_random_uuid();
  v_task uuid;
  v_replay uuid;
begin
  insert into auth.users(id,email,raw_user_meta_data)
  values (
    v_user,
    'agent-task-create-smoke@example.test',
    '{"full_name":"Agent Task Create Smoke"}'::jsonb
  );

  select account_id into strict v_account
  from public.profiles
  where user_id=v_user;

  insert into public.ai_runtime_policies(account_id)
  values (v_account)
  on conflict (account_id) do nothing;

  insert into public.ai_provider_connections(
    id,account_id,name,preset_id,protocol,api_root,
    encrypted_api_key,connection_fingerprint,status
  ) values (
    v_connection,v_account,'Task Create Provider','task-create-smoke',
    'openai','https://example.test/v1','encrypted-smoke-key',
    'task-create-smoke-119','verified'
  );

  insert into public.ai_agents(
    id,account_id,slug,name,purpose,status
  ) values (
    v_agent,v_account,'task-create-agent',
    'Task Create Agent','custom','active'
  );

  insert into public.ai_agent_revisions(
    id,account_id,agent_id,revision_number,status,
    provider_connection_id,model,operational_mode,outreach_policy
  ) values
    (
      v_revision,v_account,v_agent,1,'published',
      v_connection,'smoke-model','outbound',
      '{"bindings":[]}'::jsonb
    ),
    (
      v_reactive_revision,v_account,v_agent,2,'draft',
      v_connection,'smoke-model','reactive',
      '{}'::jsonb
    );

  update public.ai_agents
  set published_revision_id=v_revision
  where id=v_agent;

  v_task:=public.create_ai_agent_task(
    v_account,
    'coverage.sourcing',
    1,
    v_agent,
    v_revision,
    'manual',
    'coverage_request:00000000-0000-4000-8000-000000000999',
    'Task creation smoke',
    '{"coverageRequestId":"00000000-0000-4000-8000-000000000999"}'::jsonb,
    '{"requiredTagIds":[],"excludedTagIds":[],"maxNewContactsPerHour":5,"maxContactsPerAgentPerDay":10,"cooldownMinutes":60}'::jsonb,
    'whatsapp',
    5,
    2,
    '{"dailyMessageBudget":10}'::jsonb,
    null,
    'task-create-smoke-idempotency-119',
    'task-create-smoke-correlation-119',
    v_user
  );

  if v_task is null then
    raise exception 'generic task creation returned null';
  end if;

  if not exists (
    select 1
    from public.ai_agent_tasks
    where id=v_task
      and account_id=v_account
      and task_type='coverage.sourcing'
      and task_type_version=1
      and agent_id=v_agent
      and agent_revision_id=v_revision
      and status='queued'
      and task_context->>'coverageRequestId'
        ='00000000-0000-4000-8000-000000000999'
  ) then
    raise exception 'generic task creation row shape is invalid';
  end if;

  if (
    select count(*)
    from public.ai_agent_task_events
    where account_id=v_account
      and task_id=v_task
      and event_type='task.created'
  )<>1 then
    raise exception 'task.created event was not recorded exactly once';
  end if;

  v_replay:=public.create_ai_agent_task(
    v_account,
    'coverage.sourcing',
    1,
    v_agent,
    v_revision,
    'manual',
    'coverage_request:00000000-0000-4000-8000-000000000999',
    'Task creation smoke replay',
    '{"coverageRequestId":"00000000-0000-4000-8000-000000000999"}'::jsonb,
    '{"requiredTagIds":[],"excludedTagIds":[],"maxNewContactsPerHour":5,"maxContactsPerAgentPerDay":10,"cooldownMinutes":60}'::jsonb,
    'whatsapp',
    5,
    2,
    '{"dailyMessageBudget":10}'::jsonb,
    null,
    'task-create-smoke-idempotency-119',
    'task-create-smoke-correlation-119',
    v_user
  );

  if v_replay<>v_task then
    raise exception 'generic task creation replay is not idempotent';
  end if;

  if (
    select count(*)
    from public.ai_agent_tasks
    where account_id=v_account
      and idempotency_key='task-create-smoke-idempotency-119'
  )<>1 then
    raise exception 'generic task creation duplicated a replay';
  end if;

  update public.ai_agent_tasks
  set status='running',
      started_at=now()
  where id=v_task;

  if not public.finalize_agent_task_by_policy(
    v_task,
    'partially_completed',
    'coverage.sourcing_completion',
    1,
    'smoke_no_more_targets',
    '{"remainingAmount":"50000"}'::jsonb
  ) then
    raise exception 'generic Task policy finalizer did not transition running task';
  end if;

  if not exists (
    select 1
    from public.ai_agent_tasks
    where id=v_task
      and status='partially_completed'
      and completed_at is not null
  ) then
    raise exception 'generic Task policy finalizer persisted wrong state';
  end if;

  if not exists (
    select 1
    from public.ai_agent_task_events
    where account_id=v_account
      and task_id=v_task
      and event_type='task.partially_completed'
      and payload->>'reason'='smoke_no_more_targets'
  ) then
    raise exception 'generic Task policy finalizer event is missing';
  end if;

  update public.ai_agent_revisions
  set status='superseded'
  where id=v_revision;

  update public.ai_agent_revisions
  set status='published'
  where id=v_reactive_revision;

  update public.ai_agents
  set published_revision_id=v_reactive_revision
  where id=v_agent;

  begin
    perform public.create_ai_agent_task(
      v_account,
      'coverage.sourcing',
      1,
      v_agent,
      v_reactive_revision,
      'manual',
      'coverage_request:00000000-0000-4000-8000-000000000998',
      'Reactive revision must fail',
      '{"coverageRequestId":"00000000-0000-4000-8000-000000000998"}'::jsonb,
      '{}'::jsonb,
      'whatsapp',
      1,
      1,
      '{}'::jsonb,
      null,
      'task-create-reactive-rejected-119',
      'task-create-reactive-correlation-119',
      v_user
    );
    raise exception 'reactive revision unexpectedly created an outbound task';
  exception
    when others then
      if sqlerrm<>'AGENT_TASK_REVISION_NOT_OUTBOUND' then
        raise;
      end if;
  end;

  if has_function_privilege(
       'anon',
       'public.finalize_agent_task_by_policy(uuid,text,text,integer,text,jsonb)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.finalize_agent_task_by_policy(uuid,text,text,integer,text,jsonb)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.finalize_agent_task_by_policy(uuid,text,text,integer,text,jsonb)',
       'EXECUTE'
     ) then
    raise exception 'generic Task policy finalizer privileges are unsafe';
  end if;

  if has_function_privilege(
       'anon',
       'public.create_ai_agent_task(uuid,text,integer,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,integer,jsonb,timestamptz,text,text,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.create_ai_agent_task(uuid,text,integer,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,integer,jsonb,timestamptz,text,text,uuid)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.create_ai_agent_task(uuid,text,integer,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,integer,jsonb,timestamptz,text,text,uuid)',
       'EXECUTE'
     ) then
    raise exception 'generic task creation RPC privileges are unsafe';
  end if;

  if (
    select outbound_task_delivery_enabled
    from public.ai_runtime_policies
    where account_id=v_account
  ) is distinct from false then
    raise exception 'outbound task delivery gate must default false';
  end if;

  delete from public.ai_agent_task_events where account_id=v_account;
  delete from public.ai_agent_runs where account_id=v_account;
  delete from public.ai_agent_task_targets where account_id=v_account;
  delete from public.ai_agent_tasks where account_id=v_account;
  delete from public.ai_agent_revisions where account_id=v_account;
  delete from public.ai_agents where account_id=v_account;
  delete from public.ai_provider_connections where account_id=v_account;
  delete from public.ai_runtime_policies where account_id=v_account;
  delete from public.profiles where user_id=v_user;
  delete from public.accounts where id=v_account;
  delete from auth.users where id=v_user;

  raise notice 'generic Agent Task creation smoke passed';
end
$$;
