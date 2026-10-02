do $$
declare
  v_user_a uuid := '00000000-0000-4000-8000-000000000109';
  v_user_b uuid := '00000000-0000-4000-8000-000000000209';
  v_account_a uuid;
  v_account_b uuid;
  v_contact_a uuid := gen_random_uuid();
  v_contact_b uuid := gen_random_uuid();
  v_conversation_a uuid := gen_random_uuid();
  v_conversation_b uuid := gen_random_uuid();
  v_connection uuid := gen_random_uuid();
  v_agent uuid := gen_random_uuid();
  v_revision uuid := gen_random_uuid();
  v_task uuid := gen_random_uuid();
  v_target uuid := gen_random_uuid();
  v_inbound uuid := gen_random_uuid();
  v_outbound_run uuid;
  v_outbound_run_retry uuid;
  v_inbound_run uuid;
  v_inbound_run_retry uuid;
  v_event uuid;
  v_cross_tenant_blocked boolean := false;
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values
    (v_user_a, 'agent-task-smoke-a@example.test', '{"full_name":"Task Smoke A"}'::jsonb),
    (v_user_b, 'agent-task-smoke-b@example.test', '{"full_name":"Task Smoke B"}'::jsonb);

  select account_id into strict v_account_a
  from public.profiles where user_id = v_user_a;

  select account_id into strict v_account_b
  from public.profiles where user_id = v_user_b;

  insert into public.contacts (id, user_id, account_id, phone, name)
  values
    (v_contact_a, v_user_a, v_account_a, '+967700000109', 'Task Target A'),
    (v_contact_b, v_user_b, v_account_b, '+967700000209', 'Task Target B');

  insert into public.conversations (id, user_id, account_id, contact_id)
  values
    (v_conversation_a, v_user_a, v_account_a, v_contact_a),
    (v_conversation_b, v_user_b, v_account_b, v_contact_b);

  insert into public.ai_provider_connections (
    id, account_id, name, preset_id, protocol, api_root,
    encrypted_api_key, connection_fingerprint, status
  ) values (
    v_connection, v_account_a, 'Task Smoke Provider', 'task-smoke',
    'openai', 'https://example.test/v1', 'encrypted-smoke-key',
    'task-smoke-fingerprint-109', 'verified'
  );

  insert into public.ai_agents (
    id, account_id, slug, name, purpose, status
  ) values (
    v_agent, v_account_a, 'task-smoke-agent', 'Task Smoke Agent', 'custom', 'active'
  );

  insert into public.ai_agent_revisions (
    id, account_id, agent_id, revision_number, status,
    provider_connection_id, model
  ) values (
    v_revision, v_account_a, v_agent, 1, 'published',
    v_connection, 'smoke-model'
  );

  insert into public.ai_agent_tasks (
    id, account_id, task_type, task_type_version,
    agent_id, agent_revision_id, trigger_type, status,
    objective, channel, max_targets, max_attempts_per_target,
    idempotency_key, correlation_id, created_by
  ) values (
    v_task, v_account_a, 'coverage.sourcing', 1,
    v_agent, v_revision, 'manual', 'queued',
    'Find one bounded supplier', 'whatsapp', 2, 2,
    'task-smoke-109', 'task-smoke-correlation-109', v_user_a
  );

  insert into public.ai_agent_task_targets (
    id, account_id, task_id, contact_id, counterparty_role,
    status, conversation_id, idempotency_key
  ) values (
    v_target, v_account_a, v_task, v_contact_a, 'supplier',
    'queued', v_conversation_a, 'task-target-smoke-109'
  );

  begin
    insert into public.ai_agent_task_targets (
      account_id, task_id, contact_id, counterparty_role,
      status, idempotency_key
    ) values (
      v_account_a, v_task, v_contact_b, 'supplier',
      'candidate', 'task-target-cross-tenant-smoke-109'
    );
  exception when foreign_key_violation then
    v_cross_tenant_blocked := true;
  end;

  if not v_cross_tenant_blocked then
    raise exception 'cross-tenant target contact was not blocked';
  end if;

  v_outbound_run := public.create_agent_execution(
    v_account_a,
    v_conversation_a,
    null,
    v_agent,
    v_revision,
    v_connection,
    null,
    'task smoke outbound',
    'customer',
    'outbound',
    v_task,
    v_target,
    'task_target',
    'step:1',
    'supplier',
    'task:' || v_task::text || ':target:' || v_target::text || ':step:1:revision:' || v_revision::text
  );

  v_outbound_run_retry := public.create_agent_execution(
    v_account_a,
    v_conversation_a,
    null,
    v_agent,
    v_revision,
    v_connection,
    null,
    'task smoke outbound',
    'customer',
    'outbound',
    v_task,
    v_target,
    'task_target',
    'step:1',
    'supplier',
    'task:' || v_task::text || ':target:' || v_target::text || ':step:1:revision:' || v_revision::text
  );

  if v_outbound_run is null or v_outbound_run_retry <> v_outbound_run then
    raise exception 'outbound execution idempotency failed';
  end if;

  if not exists (
    select 1 from public.ai_agent_runs
    where id = v_outbound_run
      and run_mode = 'outbound'
      and inbound_message_id is null
      and task_id = v_task
      and task_target_id = v_target
      and trigger_type = 'task_target'
      and counterparty_role = 'supplier'
  ) then
    raise exception 'outbound execution row shape is invalid';
  end if;

  v_event := public.append_agent_task_event(
    v_account_a,
    v_task,
    v_target,
    v_outbound_run,
    'message.prepared',
    'service',
    'smoke',
    '{"smoke":true}'::jsonb
  );

  if v_event is null or not exists (
    select 1 from public.ai_agent_task_events
    where id = v_event
      and task_id = v_task
      and task_target_id = v_target
      and run_id = v_outbound_run
  ) then
    raise exception 'task event append failed';
  end if;

  insert into public.messages (
    id, conversation_id, sender_type, content_text
  ) values (
    v_inbound, v_conversation_a, 'customer', 'task platform inbound compatibility smoke'
  );

  v_inbound_run := public.create_agent_run(
    v_account_a,
    v_conversation_a,
    v_inbound,
    v_agent,
    v_revision,
    v_connection,
    null,
    'legacy inbound smoke',
    'customer'
  );

  v_inbound_run_retry := public.create_agent_run(
    v_account_a,
    v_conversation_a,
    v_inbound,
    v_agent,
    v_revision,
    v_connection,
    null,
    'legacy inbound smoke retry',
    'customer'
  );

  if v_inbound_run is null or v_inbound_run_retry <> v_inbound_run then
    raise exception 'legacy create_agent_run idempotency regressed';
  end if;

  if not exists (
    select 1 from public.ai_agent_runs
    where id = v_inbound_run
      and run_mode = 'inbound'
      and inbound_message_id = v_inbound
      and task_id is null
      and task_target_id is null
      and trigger_type = 'inbound_message'
  ) then
    raise exception 'legacy inbound run defaults are invalid';
  end if;

  delete from public.ai_agent_task_events where account_id = v_account_a;
  delete from public.ai_agent_runs where account_id = v_account_a;
  delete from public.ai_agent_task_targets where account_id = v_account_a;
  delete from public.ai_agent_tasks where account_id = v_account_a;
  delete from public.messages where conversation_id = v_conversation_a;
  delete from public.ai_agent_revisions where account_id = v_account_a;
  delete from public.ai_agents where account_id = v_account_a;
  delete from public.ai_provider_connections where account_id = v_account_a;
  delete from public.conversations where account_id in (v_account_a, v_account_b);
  delete from public.contacts where account_id in (v_account_a, v_account_b);
  delete from public.profiles where user_id in (v_user_a, v_user_b);
  delete from public.accounts where id in (v_account_a, v_account_b);
  delete from auth.users where id in (v_user_a, v_user_b);

  raise notice 'agent task platform smoke passed';
end
$$;