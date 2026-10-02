do $$
declare
  v_user uuid := '00000000-0000-4000-8000-000000000124';
  v_account uuid;
  v_agent uuid := gen_random_uuid();
  v_once uuid;
  v_recurring uuid;
  v_event_trigger uuid;
  v_event uuid := gen_random_uuid();
  v_result jsonb;
  v_claim jsonb;
  v_claimed integer := 0;
  v_now timestamptz := now();
begin
  insert into auth.users(id,email,raw_user_meta_data)
  values (
    v_user,
    'agent-task-trigger-smoke@example.test',
    '{"full_name":"Agent Task Trigger Smoke"}'::jsonb
  );

  select account_id into strict v_account
  from public.profiles
  where user_id = v_user;

  insert into public.ai_agents(
    id,account_id,slug,name,purpose,status
  ) values (
    v_agent,v_account,'trigger-smoke-agent',
    'Trigger Smoke Agent','custom','active'
  );

  v_once := public.create_agent_task_trigger(
    v_account,
    'services.promotion',
    1,
    v_agent,
    'schedule',
    'once',
    v_now - interval '1 minute',
    null,
    null,
    null,
    jsonb_build_object('serviceId', gen_random_uuid()),
    '{}'::jsonb,
    'trigger-smoke-once-124',
    v_user
  );

  v_recurring := public.create_agent_task_trigger(
    v_account,
    'services.promotion',
    1,
    v_agent,
    'schedule',
    'recurring',
    v_now - interval '1 minute',
    60,
    null,
    null,
    jsonb_build_object('serviceId', gen_random_uuid()),
    '{}'::jsonb,
    'trigger-smoke-recurring-124',
    v_user
  );

  v_event_trigger := public.create_agent_task_trigger(
    v_account,
    'coverage.sourcing',
    1,
    v_agent,
    'business_event',
    null,
    null,
    null,
    'coverage.request.approved',
    1,
    '{}'::jsonb,
    '{"subject_type":"coverage_request"}'::jsonb,
    'trigger-smoke-event-124',
    v_user
  );

  insert into public.business_event_outbox(
    id,account_id,event_type,event_version,subject_type,subject_id,
    actor_type,actor_id,audience,channel,correlation_id,causation_id,
    payload,delivery_mode,status,dedupe_key
  ) values (
    v_event,v_account,'coverage.request.approved',1,
    'coverage_request',gen_random_uuid()::text,
    'system','trigger-smoke','internal',null,
    'trigger-smoke-correlation',null,
    '{"source":"trigger-smoke"}'::jsonb,
    'shadow','pending','trigger-smoke-business-event-124'
  );

  v_result := public.materialize_agent_task_trigger_firings(v_now, 20);

  if (v_result->>'schedule_firings')::integer <> 2
     or (v_result->>'business_event_firings')::integer <> 1 then
    raise exception 'Unexpected trigger materialization result: %', v_result;
  end if;

  v_result := public.materialize_agent_task_trigger_firings(v_now, 20);
  if (v_result->>'schedule_firings')::integer <> 0
     or (v_result->>'business_event_firings')::integer <> 0 then
    raise exception 'Trigger materialization is not idempotent: %', v_result;
  end if;

  if not exists (
    select 1
    from public.ai_agent_task_triggers
    where id = v_once
      and status = 'completed'
      and next_fire_at is null
  ) then
    raise exception 'One-time schedule did not become terminal';
  end if;

  if not exists (
    select 1
    from public.ai_agent_task_triggers
    where id = v_recurring
      and status = 'enabled'
      and next_fire_at > v_now
  ) then
    raise exception 'Recurring schedule did not advance deterministically';
  end if;

  if not public.set_agent_task_trigger_status(
    v_account,v_event_trigger,'paused'
  ) then
    raise exception 'Business Event trigger pause failed';
  end if;

  if not public.set_agent_task_trigger_status(
    v_account,v_event_trigger,'enabled'
  ) then
    raise exception 'Business Event trigger resume failed';
  end if;

  loop
    v_claim := public.claim_next_agent_task_trigger_firing(
      'trigger-smoke-worker',
      120
    );
    exit when v_claim is null;
    v_claimed := v_claimed + 1;

    if not public.complete_agent_task_trigger_firing(
      (v_claim->>'firing_id')::uuid,
      'trigger-smoke-worker',
      null
    ) then
      raise exception 'Trigger firing completion failed: %', v_claim;
    end if;
  end loop;

  if v_claimed <> 3 then
    raise exception 'Expected 3 trigger firings, claimed %', v_claimed;
  end if;

  if exists (
    select 1
    from public.ai_agent_task_trigger_firings
    where account_id = v_account
      and status <> 'completed'
  ) then
    raise exception 'Trigger firing queue did not drain cleanly';
  end if;

  delete from public.ai_agent_task_trigger_firings where account_id=v_account;
  delete from public.ai_agent_task_triggers where account_id=v_account;
  delete from public.business_event_outbox where account_id=v_account;
  delete from public.ai_agents where account_id=v_account;
  delete from public.profiles where user_id=v_user;
  delete from public.accounts where id=v_account;
  delete from auth.users where id=v_user;

  raise notice 'Agent Task trigger smoke passed';
end
$$;
