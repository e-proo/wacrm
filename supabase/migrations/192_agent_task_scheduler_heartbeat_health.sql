-- SCH-4: single durable, lease-fenced TEST Agent Task worker heartbeat and
-- strictly tenant-scoped, redacted scheduling health metrics.
-- The heartbeat does not authorize any Task or WhatsApp send.
create table public.ai_agent_task_scheduler_heartbeat (
  runner text primary key check (runner = 'test_agent_task'),
  lease_owner uuid,
  lease_expires_at timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  tick_count bigint not null default 0 check (tick_count >= 0),
  last_result text check (last_result in ('success', 'failed')),
  last_claimed integer not null default 0 check (last_claimed >= 0),
  last_completed integer not null default 0 check (last_completed >= 0),
  last_failed integer not null default 0 check (last_failed >= 0),
  last_dead integer not null default 0 check (last_dead >= 0),
  constraint agent_task_scheduler_lease_pair_check
    check ((lease_owner is null) = (lease_expires_at is null))
);
alter table public.ai_agent_task_scheduler_heartbeat enable row level security;
revoke all on public.ai_agent_task_scheduler_heartbeat from public, anon, authenticated;
grant select, insert, update on public.ai_agent_task_scheduler_heartbeat to service_role;

-- One shared lease across HTTP invocations and local TEST timers.
-- It is deliberately longer than maxDuration=60, and expires after a crash.
create or replace function public.begin_agent_task_scheduler_tick(
  p_owner uuid,
  p_lease_seconds integer default 120
) returns boolean language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if p_owner is null or p_lease_seconds < 90 or p_lease_seconds > 300
    or p_lease_seconds is null then
    raise exception 'AGENT_TASK_SCHEDULER_LEASE_INVALID';
  end if;
  insert into public.ai_agent_task_scheduler_heartbeat (
    runner, lease_owner, lease_expires_at, last_started_at
  ) values (
    'test_agent_task', p_owner,
    pg_catalog.now() + make_interval(secs => p_lease_seconds),
    pg_catalog.now()
  )
  on conflict (runner) do update
    set lease_owner = excluded.lease_owner,
        lease_expires_at = excluded.lease_expires_at,
        last_started_at = excluded.last_started_at
  where public.ai_agent_task_scheduler_heartbeat.lease_owner is null
     or public.ai_agent_task_scheduler_heartbeat.lease_expires_at <= pg_catalog.now();
  return found;
end;
$$;
revoke all on function public.begin_agent_task_scheduler_tick(uuid,integer)
  from public, anon, authenticated;
grant execute on function public.begin_agent_task_scheduler_tick(uuid,integer)
  to service_role;

-- Late/outdated owners cannot mark a reclaimed tick as successful.
-- Only bounded numeric counts are stored. Never persist phone, Task, key or error text.
create or replace function public.finish_agent_task_scheduler_tick(
  p_owner uuid,
  p_success boolean,
  p_claimed integer default 0,
  p_completed integer default 0,
  p_failed integer default 0,
  p_dead integer default 0
) returns boolean language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if p_owner is null or p_success is null
    or p_claimed is null or p_claimed < 0 or p_claimed > 100
    or p_completed is null or p_completed < 0 or p_completed > 100
    or p_failed is null or p_failed < 0 or p_failed > 100
    or p_dead is null or p_dead < 0 or p_dead > 100 then
    raise exception 'AGENT_TASK_SCHEDULER_RESULT_INVALID';
  end if;
  update public.ai_agent_task_scheduler_heartbeat h
  set lease_owner = null, lease_expires_at = null,
      last_finished_at = pg_catalog.now(),
      last_succeeded_at = case when p_success then pg_catalog.now()
                               else h.last_succeeded_at end,
      last_failed_at = case when p_success then h.last_failed_at
                            else pg_catalog.now() end,
      consecutive_failures = case when p_success then 0
                               else least(h.consecutive_failures + 1, 1000000) end,
      last_result = case when p_success then 'success' else 'failed' end,
      tick_count = h.tick_count + 1,
      last_claimed = p_claimed, last_completed = p_completed,
      last_failed = p_failed, last_dead = p_dead
  where h.runner = 'test_agent_task'
    and h.lease_owner = p_owner
    and h.lease_expires_at > pg_catalog.now();
  return found;
end;
$$;
revoke all on function public.finish_agent_task_scheduler_tick(uuid,boolean,integer,integer,integer,integer)
  from public, anon, authenticated;
grant execute on function public.finish_agent_task_scheduler_tick(uuid,boolean,integer,integer,integer,integer)
  to service_role;

-- Read-only report: every scheduler/firing query is tenant-filtered.
-- The singleton heartbeat contains only redacted global TEST operational counters.
create or replace function public.inspect_agent_task_schedule_health(
  p_account_id uuid
) returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  v_enabled bigint;
  v_oldest_due timestamptz;
  v_skipped bigint;
  v_pending bigint;
  v_claimed bigint;
  v_failed bigint;
  v_dead bigint;
  v_skipped_firings bigint;
  v_stale_claims bigint;
  v_oldest_available timestamptz;
  v_cap integer;
  v_worker_enabled boolean;
  v_heartbeat public.ai_agent_task_scheduler_heartbeat%rowtype;
begin
  if p_account_id is null then
    raise exception 'AGENT_TASK_SCHEDULER_ACCOUNT_REQUIRED';
  end if;
  select count(*) filter (where status = 'enabled'),
         min(next_fire_at) filter (where status = 'enabled' and
           trigger_kind = 'schedule' and next_fire_at <= pg_catalog.now()),
         coalesce(sum(skipped_occurrences), 0)
  into v_enabled, v_oldest_due, v_skipped
  from public.ai_agent_task_triggers
  where account_id = p_account_id;

  select count(*) filter (where status = 'pending'),
         count(*) filter (where status = 'claimed'),
         count(*) filter (where status = 'failed'),
         count(*) filter (where status = 'dead'),
         count(*) filter (where status = 'skipped'),
         count(*) filter (where status = 'claimed' and
           lease_expires_at <= pg_catalog.now()),
         min(available_at) filter (where status in ('pending', 'failed') and
           available_at <= pg_catalog.now())
  into v_pending, v_claimed, v_failed, v_dead, v_skipped_firings,
       v_stale_claims, v_oldest_available
  from public.ai_agent_task_trigger_firings
  where account_id = p_account_id;

  select coalesce(agent_task_trigger_max_pending, 100),
         coalesce(task_worker_enabled, true)
  into v_cap, v_worker_enabled
  from public.ai_runtime_policies
  where account_id = p_account_id;
  v_cap := coalesce(v_cap, 100);
  v_worker_enabled := coalesce(v_worker_enabled, true);

  select * into v_heartbeat
  from public.ai_agent_task_scheduler_heartbeat
  where runner = 'test_agent_task';

  return jsonb_build_object(
    'enabledSchedules', v_enabled,
    'pending', v_pending, 'claimed', v_claimed, 'failed', v_failed,
    'dead', v_dead, 'skippedFirings', v_skipped_firings,
    'skippedOccurrences', v_skipped,
    'backlog', v_pending + v_claimed + v_failed, 'backlogCap', v_cap,
    'staleClaims', v_stale_claims,
    'oldestDueAt', v_oldest_due, 'oldestAvailableAt', v_oldest_available,
    'dueLagSeconds', case when v_oldest_due is null then 0
      else greatest(0, floor(extract(epoch from
        pg_catalog.now() - v_oldest_due)))::integer end,
    'backlogLagSeconds', case when v_oldest_available is null then 0
      else greatest(0, floor(extract(epoch from
        pg_catalog.now() - v_oldest_available)))::integer end,
    'taskWorkerEnabled', v_worker_enabled,
    'runnerLastStartedAt', v_heartbeat.last_started_at,
    'runnerLastFinishedAt', v_heartbeat.last_finished_at,
    'runnerLastSucceededAt', v_heartbeat.last_succeeded_at,
    'runnerLastFailedAt', v_heartbeat.last_failed_at,
    'runnerLeaseUntil', v_heartbeat.lease_expires_at,
    'runnerConsecutiveFailures', coalesce(v_heartbeat.consecutive_failures, 0),
    'runnerLastResult', v_heartbeat.last_result,
    'runnerTickCount', coalesce(v_heartbeat.tick_count, 0),
    'runnerLastClaimed', coalesce(v_heartbeat.last_claimed, 0),
    'runnerLastCompleted', coalesce(v_heartbeat.last_completed, 0),
    'runnerLastFailedCount', coalesce(v_heartbeat.last_failed, 0),
    'runnerLastDead', coalesce(v_heartbeat.last_dead, 0),
    'observedAt', pg_catalog.now()
  );
end;
$$;
revoke all on function public.inspect_agent_task_schedule_health(uuid)
  from public, anon, authenticated;
grant execute on function public.inspect_agent_task_schedule_health(uuid)
  to service_role;
