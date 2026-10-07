begin;

-- Phase 6 / NOTE-004: table privileges are a prerequisite for RLS.
-- Assert the intended client surface explicitly so a change in Supabase
-- defaults cannot silently make clean replay differ from long-lived TEST.
do $phase6_acl$
begin
  if not has_table_privilege('authenticated', 'public.ai_agent_runs', 'SELECT')
     or not has_table_privilege('authenticated', 'public.ai_agent_runs', 'UPDATE') then
    raise exception 'authenticated must have SELECT+UPDATE on ai_agent_runs';
  end if;

  if has_table_privilege('authenticated', 'public.ai_agent_runs', 'INSERT')
     or has_table_privilege('authenticated', 'public.ai_agent_runs', 'DELETE') then
    raise exception 'authenticated must not have INSERT/DELETE on ai_agent_runs';
  end if;

  if has_table_privilege('anon', 'public.ai_agent_runs', 'SELECT')
     or has_table_privilege('anon', 'public.ai_agent_runs', 'INSERT')
     or has_table_privilege('anon', 'public.ai_agent_runs', 'UPDATE')
     or has_table_privilege('anon', 'public.ai_agent_runs', 'DELETE') then
    raise exception 'anon must not have table privileges on ai_agent_runs';
  end if;

  if not has_table_privilege('authenticated', 'public.ai_agent_run_events', 'SELECT') then
    raise exception 'authenticated must have SELECT on ai_agent_run_events';
  end if;

  if has_table_privilege('authenticated', 'public.ai_agent_run_events', 'INSERT')
     or has_table_privilege('authenticated', 'public.ai_agent_run_events', 'UPDATE')
     or has_table_privilege('authenticated', 'public.ai_agent_run_events', 'DELETE') then
    raise exception 'authenticated must not mutate ai_agent_run_events';
  end if;

  if has_table_privilege('anon', 'public.ai_agent_run_events', 'SELECT')
     or has_table_privilege('anon', 'public.ai_agent_run_events', 'INSERT')
     or has_table_privilege('anon', 'public.ai_agent_run_events', 'UPDATE')
     or has_table_privilege('anon', 'public.ai_agent_run_events', 'DELETE') then
    raise exception 'anon must not have table privileges on ai_agent_run_events';
  end if;

  if not has_table_privilege('service_role', 'public.ai_agent_runs', 'SELECT')
     or not has_table_privilege('service_role', 'public.ai_agent_runs', 'INSERT')
     or not has_table_privilege('service_role', 'public.ai_agent_runs', 'UPDATE')
     or not has_table_privilege('service_role', 'public.ai_agent_runs', 'DELETE')
     or not has_table_privilege('service_role', 'public.ai_agent_run_events', 'SELECT')
     or not has_table_privilege('service_role', 'public.ai_agent_run_events', 'INSERT')
     or not has_table_privilege('service_role', 'public.ai_agent_run_events', 'UPDATE')
     or not has_table_privilege('service_role', 'public.ai_agent_run_events', 'DELETE') then
    raise exception 'service_role Agent Run table privileges are incomplete';
  end if;
end
$phase6_acl$;

do $phase17_fixture$
declare
  v_user_a uuid := '00000000-0000-4000-8000-000000000117';
  v_user_b uuid := '00000000-0000-4000-8000-000000000217';
  v_account_a uuid;
  v_connection uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_revision uuid := gen_random_uuid();
  v_task uuid := gen_random_uuid();
  v_contact uuid := gen_random_uuid();
  v_conversation uuid := gen_random_uuid();
  v_target uuid := gen_random_uuid();
  v_run uuid;
begin
  insert into auth.users (id,email,raw_user_meta_data)
  values
    (
      v_user_a,
      'phase17-rls-a@example.test',
      '{"full_name":"Phase 17 RLS A"}'::jsonb
    ),
    (
      v_user_b,
      'phase17-rls-b@example.test',
      '{"full_name":"Phase 17 RLS B"}'::jsonb
    );

  select account_id into strict v_account_a
  from public.profiles
  where user_id=v_user_a;

  insert into public.ai_provider_connections(
    id,account_id,name,preset_id,protocol,api_root,
    encrypted_api_key,connection_fingerprint,status
  ) values (
    v_connection,v_account_a,
    'Phase17 RLS Provider','phase17-rls',
    'openai','https://example.test/v1',
    'encrypted-phase17-rls',
    'phase17-rls-fingerprint','verified'
  );

  insert into public.ai_agents(
    id,account_id,slug,name,purpose,status
  ) values (
    v_agent,v_account_a,
    'phase17-rls-agent','Phase 17 RLS Agent','custom','active'
  );

  insert into public.ai_agent_revisions(
    id,account_id,agent_id,revision_number,status,
    provider_connection_id,model
  ) values (
    v_revision,v_account_a,v_agent,1,'published',
    v_connection,'phase17-rls-model'
  );

  update public.ai_agents
  set published_revision_id=v_revision
  where id=v_agent;

  insert into public.contacts(
    id,user_id,account_id,phone,name
  ) values (
    v_contact,v_user_a,v_account_a,
    '+967700000117','Phase 17 RLS Contact'
  );

  insert into public.conversations(
    id,user_id,account_id,contact_id,status
  ) values (
    v_conversation,v_user_a,v_account_a,v_contact,'open'
  );

  insert into public.ai_agent_tasks(
    id,account_id,task_type,task_type_version,
    agent_id,agent_revision_id,trigger_type,status,
    objective,channel,max_targets,max_attempts_per_target,
    idempotency_key,correlation_id,created_by
  ) values (
    v_task,v_account_a,'services.promotion',1,
    v_agent,v_revision,'manual','running',
    'Phase 17 RLS acceptance','whatsapp',1,1,
    'phase17-rls-task-117',
    'phase17-rls-correlation-117',
    v_user_a
  );

  insert into public.ai_agent_task_targets(
    id,account_id,task_id,contact_id,counterparty_role,
    status,conversation_id,idempotency_key
  ) values (
    v_target,v_account_a,v_task,v_contact,
    'service_customer','in_progress',v_conversation,
    'phase17-rls-target-117'
  );

  v_run:=public.create_agent_execution(
    v_account_a,v_conversation,null,
    v_agent,v_revision,v_connection,
    null,'phase17 rls','customer','outbound',
    v_task,v_target,'task_target','attempt:1',
    'service_customer','phase17-rls-run-117'
  );

  perform public.append_agent_task_event(
    v_account_a,v_task,v_target,v_run,
    'target.selected','service','phase17-rls',
    '{}'::jsonb
  );

  -- Store fixture ids in transaction-local settings so authenticated
  -- assertions can resolve them after SET ROLE.
  perform set_config('phase17.account_a',v_account_a::text,true);
  perform set_config('phase17.task',v_task::text,true);
  perform set_config('phase17.target',v_target::text,true);
  perform set_config('phase17.run',v_run::text,true);
end
$phase17_fixture$;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000000117',
  true
);

do $$
declare
  v_account_a uuid := current_setting('phase17.account_a')::uuid;
  v_task uuid := current_setting('phase17.task')::uuid;
  v_target uuid := current_setting('phase17.target')::uuid;
  v_run uuid := current_setting('phase17.run')::uuid;
begin
  if (select count(*) from public.ai_agent_tasks where id=v_task)<>1 then
    raise exception 'Owner cannot read own Agent Task through RLS';
  end if;

  if (
    select count(*)
    from public.ai_agent_task_targets
    where id=v_target
  )<>1 then
    raise exception 'Owner cannot read own Agent Task target through RLS';
  end if;

  if (select count(*) from public.ai_agent_runs where id=v_run)<>1 then
    raise exception 'Owner cannot read own Agent Run through RLS';
  end if;

  if (
    select count(*)
    from public.ai_agent_task_events
    where account_id=v_account_a and task_id=v_task
  )<1 then
    raise exception 'Owner cannot read own Agent Task event through RLS';
  end if;

  update public.ai_agent_tasks
  set objective='Phase 17 RLS owner update'
  where id=v_task;

  if not found then
    raise exception 'Owner/admin RLS update policy denied own Task';
  end if;
end
$$;

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000000217',
  true
);

do $$
declare
  v_account_a uuid := current_setting('phase17.account_a')::uuid;
  v_task uuid := current_setting('phase17.task')::uuid;
  v_target uuid := current_setting('phase17.target')::uuid;
  v_run uuid := current_setting('phase17.run')::uuid;
  v_visible bigint;
begin
  select count(*) into v_visible
  from public.ai_agent_tasks
  where id=v_task;
  if v_visible<>0 then
    raise exception 'Cross-tenant Agent Task leaked through RLS';
  end if;

  select count(*) into v_visible
  from public.ai_agent_task_targets
  where id=v_target;
  if v_visible<>0 then
    raise exception 'Cross-tenant Agent Task target leaked through RLS';
  end if;

  select count(*) into v_visible
  from public.ai_agent_runs
  where id=v_run;
  if v_visible<>0 then
    raise exception 'Cross-tenant Agent Run leaked through RLS';
  end if;

  select count(*) into v_visible
  from public.ai_agent_task_events
  where account_id=v_account_a and task_id=v_task;
  if v_visible<>0 then
    raise exception 'Cross-tenant Agent Task event leaked through RLS';
  end if;

  update public.ai_agent_tasks
  set objective='cross-tenant write must not happen'
  where id=v_task;

  if found then
    raise exception 'Cross-tenant Agent Task update escaped RLS';
  end if;

  begin
    insert into public.ai_agent_task_targets(
      account_id,task_id,contact_id,counterparty_role,
      status,idempotency_key
    )
    select
      account_id,id,null,'service_customer',
      'candidate','phase17-rls-cross-insert-117'
    from public.ai_agent_tasks
    where id=v_task;

    if found then
      raise exception 'Cross-tenant target insert escaped RLS';
    end if;
  exception
    when insufficient_privilege then
      null;
  end;
end
$$;

reset role;

rollback;
