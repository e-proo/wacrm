do $$
declare
  v_user uuid := '00000000-0000-4000-8000-000000000124';
  v_account uuid;
  v_agent uuid := gen_random_uuid();
  v_once uuid;
  v_recurring uuid;
  v_event_trigger uuid;
  v_event uuid := gen_random_uuid();
  v_rejected_firing uuid;
  v_other_user uuid := '00000000-0000-4000-8000-000000000125';
  v_other_account uuid;
  v_other_agent uuid := gen_random_uuid();
  v_other_trigger uuid;
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
      (v_claim->>'claim_owner'),
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

  -- SCH-1: a missed 3-hour backlog yields one latest firing, not three sends.
  update public.ai_agent_task_triggers
     set next_fire_at = v_now - interval '3 hours'
   where id = v_recurring;

  v_result := public.materialize_agent_task_trigger_firings(v_now, 20);
  if (v_result->>'schedule_firings')::integer <> 1 then
    raise exception 'Backlog coalescing did not produce one firing: %', v_result;
  end if;

  if not exists (
    select 1 from public.ai_agent_task_triggers
    where id = v_recurring
      and skipped_occurrences = 3
      and next_fire_at = v_now + interval '1 hour'
  ) then
    raise exception 'Missed intervals were not durably accounted';
  end if;

  if not exists (
    select 1 from public.ai_agent_task_trigger_firings
    where trigger_id = v_recurring
      and scheduled_for = v_now
      and status = 'pending'
  ) then
    raise exception 'Coalesced firing must retain latest due source identity';
  end if;

  v_result := public.materialize_agent_task_trigger_firings(v_now, 20);
  if (v_result->>'schedule_firings')::integer <> 0 then
    raise exception 'Coalesced recurrence replayed on second tick';
  end if;

  -- SCH-1: pausing an already-materialized pending firing must block claims.
  if not public.set_agent_task_trigger_status(v_account, v_recurring, 'paused') then
    raise exception 'Recurring trigger pause failed';
  end if;

  if not exists (
    select 1 from public.ai_agent_task_trigger_firings
    where trigger_id = v_recurring and status = 'pending'
  ) then
    raise exception 'Pause regression requires an existing pending firing';
  end if;

  v_claim := public.claim_next_agent_task_trigger_firing('trigger-smoke-worker', 120);
  if v_claim is not null then
    raise exception 'Paused recurring trigger leaked a pending firing: %', v_claim;
  end if;

  if not public.set_agent_task_trigger_status(v_account, v_recurring, 'enabled') then
    raise exception 'Recurring trigger resume failed';
  end if;

  v_claim := public.claim_next_agent_task_trigger_firing('trigger-smoke-worker', 120);
  if v_claim is null or (v_claim->>'trigger_id')::uuid <> v_recurring then
    raise exception 'Resumed recurring trigger did not reclaim its pending firing: %', v_claim;
  end if;

  if not public.complete_agent_task_trigger_firing(
    (v_claim->>'firing_id')::uuid, (v_claim->>'claim_owner'), null
  ) then
    raise exception 'Resumed recurring firing completion failed';
  end if;

  -- SCH-1: account-level pause must block claims for already queued firings.
  update public.ai_runtime_policies
     set task_worker_enabled = false
   where account_id = v_account;
  if not found then
    insert into public.ai_runtime_policies(account_id, task_worker_enabled)
    values (v_account, false);
  end if;

  update public.ai_agent_task_triggers
     set next_fire_at = v_now - interval '1 minute'
   where id = v_recurring;
  -- Insert while the policy is enabled, then pause. The new insert-time
  -- freeze guard intentionally rejects inserts for already-paused policies.
  perform public.set_agent_task_trigger_status(v_account,v_recurring,'enabled');
  insert into public.ai_agent_task_trigger_firings(
    account_id, trigger_id, source_kind, source_key, scheduled_for, available_at
  ) values (
    v_account, v_recurring, 'schedule',
    'schedule:account-pause-smoke:' || v_recurring::text,
    v_now - interval '1 minute', v_now - interval '1 minute'
  );
  perform public.set_agent_task_trigger_status(v_account,v_recurring,'paused');

  v_claim := public.claim_next_agent_task_trigger_firing('trigger-smoke-worker', 120);
  if v_claim is not null then
    raise exception 'Account pause leaked an already queued firing: %', v_claim;
  end if;

  update public.ai_runtime_policies
     set task_worker_enabled = true
   where account_id = v_account;
  v_claim := public.claim_next_agent_task_trigger_firing('trigger-smoke-worker', 120);
  if v_claim is null or (v_claim->>'trigger_id')::uuid <> v_recurring then
    raise exception 'Account resume did not restore queued firing: %', v_claim;
  end if;
  if not public.complete_agent_task_trigger_firing(
    (v_claim->>'firing_id')::uuid, (v_claim->>'claim_owner'), null
  ) then
    raise exception 'Account resume completion failed';
  end if;


  -- SCH-1: an expired claim cannot complete or fail, and another worker can reclaim.
  insert into public.ai_agent_task_trigger_firings(
    account_id, trigger_id, source_kind, source_key, scheduled_for, available_at
  ) values (
    v_account, v_recurring, 'schedule',
    'schedule:expired-lease-smoke:' || v_recurring::text,
    v_now - interval '1 minute', v_now - interval '1 minute'
  );

  v_claim := public.claim_next_agent_task_trigger_firing('lease-worker-shared', 120);
  if v_claim is null or (v_claim->>'trigger_id')::uuid <> v_recurring then
    raise exception 'Lease smoke could not claim queued firing: %', v_claim;
  end if;

  update public.ai_agent_task_trigger_firings
     set lease_expires_at = now() - interval '1 second'
   where id = (v_claim->>'firing_id')::uuid;

  if public.complete_agent_task_trigger_firing(
    (v_claim->>'firing_id')::uuid, (v_claim->>'claim_owner'), null
  ) then
    raise exception 'Expired lease was allowed to complete';
  end if;
  if public.fail_agent_task_trigger_firing(
    (v_claim->>'firing_id')::uuid, (v_claim->>'claim_owner'), 'stale', 0
  ) is not null then
    raise exception 'Expired lease was allowed to fail';
  end if;

  v_result := public.claim_next_agent_task_trigger_firing('lease-worker-shared', 120);
  if v_result is null
     or (v_result->>'firing_id')::uuid <> (v_claim->>'firing_id')::uuid
     or (v_result->>'attempts')::integer <> 2 then
    raise exception 'Expired lease was not reclaimed with same firing identity: %', v_result;
  end if;

  if (v_result->>'claim_owner') = (v_claim->>'claim_owner')
     or (v_result->>'lease_generation')::bigint <>
       (v_claim->>'lease_generation')::bigint + 1 then
    raise exception 'Same worker ID reused lease generation without fencing';
  end if;
  if public.complete_agent_task_trigger_firing(
    (v_claim->>'firing_id')::uuid, (v_claim->>'claim_owner'), null
  ) then
    raise exception 'Old lease owner completed a reclaimed firing';
  end if;
  if not public.complete_agent_task_trigger_firing(
    (v_result->>'firing_id')::uuid, (v_result->>'claim_owner'), null
  ) then
    raise exception 'New lease owner could not complete reclaimed firing';
  end if;

  -- SCH-1: the per-account pending cap is enforced at insert (not only worker tick).
  update public.ai_runtime_policies
     set agent_task_trigger_max_pending = 1
   where account_id = v_account;
  insert into public.ai_agent_task_trigger_firings(
    account_id,trigger_id,source_kind,source_key,scheduled_for,available_at
  ) values (
    v_account,v_recurring,'schedule',
    'schedule:backlog-occupant:' || v_recurring::text,
    v_now - interval '4 minutes',v_now - interval '4 minutes'
  );
  v_rejected_firing := null;
  insert into public.ai_agent_task_trigger_firings(
    account_id,trigger_id,source_kind,source_key,scheduled_for,available_at
  ) values (
    v_account,v_recurring,'schedule',
    'schedule:backlog-rejected:' || v_recurring::text,
    v_now - interval '3 minutes',v_now - interval '3 minutes'
  ) returning id into v_rejected_firing;
  if v_rejected_firing is not null then
    raise exception 'Per-account backlog cap admitted a second firing';
  end if;

  update public.ai_agent_task_triggers
     set next_fire_at = v_now - interval '2 minutes'
   where id = v_recurring;
  v_result := public.materialize_agent_task_trigger_firings(v_now,20);
  if (v_result->>'schedule_firings')::integer <> 0
     or (v_result->>'schedule_deferred')::integer <> 1 then
    raise exception 'Full backlog did not defer schedule: %',v_result;
  end if;
  if not exists (
    select 1 from public.ai_agent_task_triggers
    where id=v_recurring and next_fire_at=v_now - interval '2 minutes'
  ) then
    raise exception 'Due schedule advanced despite blocked admission';
  end if;
  v_claim := public.claim_next_agent_task_trigger_firing('backlog-worker',120);
  if v_claim is null or (v_claim->>'account_id')::uuid <> v_account
     or not public.complete_agent_task_trigger_firing(
       (v_claim->>'firing_id')::uuid,(v_claim->>'claim_owner'),null
     ) then
    raise exception 'Backlog occupant did not drain safely: %',v_claim;
  end if;
  v_result := public.materialize_agent_task_trigger_firings(v_now,20);
  if (v_result->>'schedule_firings')::integer <> 1 then
    raise exception 'Deferred schedule not recovered after drain: %',v_result;
  end if;

  -- Fairness: a previously unserved account is selected ahead of a busy one.
  insert into auth.users(id,email,raw_user_meta_data)
  values (
    v_other_user,'agent-task-fairness@example.test',
    '{"full_name":"Trigger Fairness Smoke"}'::jsonb
  );
  select account_id into strict v_other_account
  from public.profiles where user_id=v_other_user;
  insert into public.ai_agents(id,account_id,slug,name,purpose,status)
  values (v_other_agent,v_other_account,'trigger-fairness-agent',
          'Trigger Fairness Agent','custom','active');
  v_other_trigger := public.create_agent_task_trigger(
    v_other_account,'services.promotion',1,v_other_agent,
    'schedule','once',v_now - interval '1 minute',null,null,null,
    jsonb_build_object('serviceId',gen_random_uuid()),'{}'::jsonb,
    'trigger-fairness-once-186',v_other_user
  );
  insert into public.ai_agent_task_trigger_firings(
    account_id,trigger_id,source_kind,source_key,scheduled_for,available_at
  ) values (
    v_other_account,v_other_trigger,'schedule',
    'schedule:fairness:' || v_other_trigger::text,
    v_now - interval '1 minute',v_now
  );
  v_claim := public.claim_next_agent_task_trigger_firing('fair-worker',120);
  if v_claim is null or (v_claim->>'account_id')::uuid <> v_other_account
     or not public.complete_agent_task_trigger_firing(
       (v_claim->>'firing_id')::uuid,(v_claim->>'claim_owner'),null
     ) then
    raise exception 'Unserved account did not get fair first claim: %',v_claim;
  end if;
  v_claim := public.claim_next_agent_task_trigger_firing('fair-worker',120);
  if v_claim is null or (v_claim->>'account_id')::uuid <> v_account
     or not public.complete_agent_task_trigger_firing(
       (v_claim->>'firing_id')::uuid,(v_claim->>'claim_owner'),null
     ) then
    raise exception 'Busy account was not served after fair claim: %',v_claim;
  end if;

  if pg_catalog.has_function_privilege(
       'authenticated','public.claim_next_agent_task_trigger_firing(text,integer)','EXECUTE'
     ) then
    raise exception 'Authenticated user may execute service-only scheduler claim';
  end if;
  delete from public.ai_agent_task_trigger_firings where account_id=v_other_account;
  delete from public.ai_agent_task_triggers where account_id=v_other_account;
  delete from public.ai_agents where account_id=v_other_account;
  delete from public.profiles where user_id=v_other_user;
  delete from public.accounts where id=v_other_account;
  delete from auth.users where id=v_other_user;

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
