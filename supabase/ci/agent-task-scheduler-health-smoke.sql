-- SCH-4: transactional global lease fencing, monitoring boundary and replay-safe heartbeat.
begin;
do $$
declare
  first_owner uuid := '00000000-0000-4000-8000-000000000192';
  second_owner uuid := '00000000-0000-4000-8000-000000000193';
  health jsonb;
  baseline_tick_count bigint;
begin
  if not (select relrowsecurity from pg_class
          where oid = 'public.ai_agent_task_scheduler_heartbeat'::regclass) then
    raise exception 'SCH4_HEARTBEAT_RLS_OFF';
  end if;
  if has_table_privilege('authenticated',
      'public.ai_agent_task_scheduler_heartbeat', 'SELECT')
    or has_function_privilege('authenticated',
      'public.begin_agent_task_scheduler_tick(uuid,integer)', 'EXECUTE')
    or has_function_privilege('authenticated',
      'public.finish_agent_task_scheduler_tick(uuid,boolean,integer,integer,integer,integer)', 'EXECUTE')
    or has_function_privilege('authenticated',
      'public.inspect_agent_task_schedule_health(uuid)', 'EXECUTE') then
    raise exception 'SCH4_AUTHENTICATED_EXPOSURE';
  end if;
  if not has_function_privilege('service_role',
      'public.inspect_agent_task_schedule_health(uuid)', 'EXECUTE') then
    raise exception 'SCH4_SERVICE_ROLE_GRANT_MISSING';
  end if;

  if not public.begin_agent_task_scheduler_tick(first_owner, 120) then
    raise exception 'SCH4_INITIAL_CLAIM_MISSING';
  end if;
  -- The first claim holds the global heartbeat row lock in this rollback-only
  -- transaction. Compare the delta, not a clean-database absolute counter.
  health := public.inspect_agent_task_schedule_health('00000000-0000-4000-8000-000000000194');
  baseline_tick_count := (health->>'runnerTickCount')::bigint;
  if baseline_tick_count IS NULL THEN RAISE EXCEPTION 'SCH4_BASELINE_MISSING'; END IF;
  if public.begin_agent_task_scheduler_tick(second_owner, 120) then
    raise exception 'SCH4_DOUBLE_CLAIM_ALLOWED';
  end if;
  if public.finish_agent_task_scheduler_tick(second_owner, true, 0, 0, 0, 0) then
    raise exception 'SCH4_FOREIGN_FINISH_ALLOWED';
  end if;
  if not public.finish_agent_task_scheduler_tick(first_owner, true, 2, 1, 1, 0) then
    raise exception 'SCH4_OWNER_FINISH_FAILED';
  end if;
  if public.finish_agent_task_scheduler_tick(first_owner, true, 2, 1, 1, 0) then
    raise exception 'SCH4_DOUBLE_FINISH_ALLOWED';
  end if;
  if not public.begin_agent_task_scheduler_tick(second_owner, 120) then
    raise exception 'SCH4_RECOVERY_CLAIM_FAILED';
  end if;
  if not public.finish_agent_task_scheduler_tick(second_owner, false, 0, 0, 0, 1) then
    raise exception 'SCH4_FAILURE_FINISH_FAILED';
  end if;
  health := public.inspect_agent_task_schedule_health(
    '00000000-0000-4000-8000-000000000194');
  if (health->>'backlog')::integer <> 0
     or (health->>'runnerTickCount')::bigint <> baseline_tick_count + 2
     or (health->>'runnerConsecutiveFailures')::integer <> 1
     or health->>'runnerLastResult' <> 'failed' then
    raise exception 'SCH4_HEALTH_METRICS_INVALID: %', health;
  end if;
  raise notice 'PASS SCH4 fenced global tick, no double claim, no stale finish, tenant-scoped health, service-only grants';
end;
$$;
rollback;
