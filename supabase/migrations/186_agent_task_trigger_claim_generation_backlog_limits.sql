-- SCH-1: DB-issued lease fencing and bounded, tenant-fair pending queue.
-- All changes additive; existing provider and Task dispatch paths remain untouched.
alter table public.ai_agent_task_trigger_firings
  add column if not exists lease_generation bigint not null default 0
  check (lease_generation >= 0);
alter table public.ai_runtime_policies
  add column if not exists agent_task_trigger_max_pending integer not null default 100
  check (agent_task_trigger_max_pending between 1 and 500);
create index if not exists ai_agent_task_trigger_pending_account_idx
  on public.ai_agent_task_trigger_firings(account_id,status,available_at)
  where status in ('pending','claimed','failed');

create table if not exists public.ai_agent_task_trigger_claim_fairness (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  last_claimed_at timestamptz not null default '-infinity'::timestamptz
);
alter table public.ai_agent_task_trigger_claim_fairness enable row level security;
revoke all on table public.ai_agent_task_trigger_claim_fairness
  from public, anon, authenticated;
grant select, insert, update, delete on table public.ai_agent_task_trigger_claim_fairness
  to service_role;

-- All inserts share a transaction-scoped account admission lock. Skip a full
-- account safely; materializer leaves its due schedule intact for next tick.
-- Non-blocking lock avoids deadlock when several tenants are interleaved.
create or replace function public.guard_agent_task_trigger_pending_capacity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_cap integer;
  v_pending integer;
begin
  if not exists (
    select 1 from public.ai_agent_task_triggers as trigger
    where trigger.id = new.trigger_id and trigger.account_id = new.account_id
  ) then
    raise exception 'AGENT_TASK_TRIGGER_FIRING_ACCOUNT_MISMATCH';
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(
    184186, pg_catalog.hashtext(new.account_id::text)
  ) then
    return null;
  end if;
  select coalesce((
    select policy.agent_task_trigger_max_pending
    from public.ai_runtime_policies as policy
    where policy.account_id = new.account_id
  ),100) into v_cap;
  select count(*) into v_pending
  from public.ai_agent_task_trigger_firings as firing
  where firing.account_id = new.account_id
    and firing.status in ('pending','claimed','failed');
  if v_pending >= v_cap then
    return null;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_agent_task_trigger_pending_capacity()
  from public, anon, authenticated;
drop trigger if exists ai_agent_task_trigger_firing_pending_guard
  on public.ai_agent_task_trigger_firings;
create trigger ai_agent_task_trigger_firing_pending_guard
  before insert on public.ai_agent_task_trigger_firings
  for each row execute function public.guard_agent_task_trigger_pending_capacity();

create or replace function public.materialize_agent_task_trigger_firings(
  p_now timestamptz default now(),
  p_limit integer default 100
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  r public.ai_agent_task_triggers%rowtype;
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 500));
  v_schedule_count integer := 0;
  v_event_count integer := 0;
  v_missed bigint := 0;
  v_occurrence timestamptz;
  v_source_key text;
  v_schedule_deferred integer := 0;
begin
  for r in
    select trigger.*
    from public.ai_agent_task_triggers as trigger
    where trigger.status = 'enabled'
      and trigger.trigger_kind = 'schedule'
      and trigger.next_fire_at is not null
      and trigger.next_fire_at <= p_now
      and coalesce((
        select policy.task_worker_enabled
        from public.ai_runtime_policies as policy
        where policy.account_id = trigger.account_id
      ), true)
    order by trigger.next_fire_at asc, trigger.id asc
    for update skip locked
    limit v_limit
  loop
    -- Collapse historical intervals to the latest due occurrence, never replay a burst.
    v_missed := case when r.schedule_kind = 'recurring' then
      greatest(0, floor(extract(epoch from (p_now - r.next_fire_at)) /
        (r.interval_minutes * 60.0))::bigint) else 0 end;
    v_occurrence := r.next_fire_at +
      (make_interval(mins => coalesce(r.interval_minutes, 0)) * v_missed::double precision);
    v_source_key := 'schedule:' || r.id::text || ':' ||
      to_char(v_occurrence at time zone 'UTC', 'YYYYMMDD"T"HH24MISS.US');
    insert into public.ai_agent_task_trigger_firings (
      account_id,
      trigger_id,
      source_kind,
      source_key,
      scheduled_for,
      available_at
    ) values (
      r.account_id,
      r.id,
      'schedule',
      v_source_key,
      v_occurrence,
      p_now
    )
    on conflict (trigger_id, source_key) do nothing;

    if found then
      v_schedule_count := v_schedule_count + 1;
    elsif not exists (
      select 1 from public.ai_agent_task_trigger_firings
      where trigger_id = r.id and source_key = v_source_key
    ) then
      -- Admission declined; do not advance or complete a due schedule.
      v_schedule_deferred := v_schedule_deferred + 1;
      continue;
    end if;

    if r.schedule_kind = 'once' then
      update public.ai_agent_task_triggers
         set status = 'completed',
             next_fire_at = null,
             updated_at = p_now
       where id = r.id;
    else
      update public.ai_agent_task_triggers
         set next_fire_at =
               v_occurrence + make_interval(mins => r.interval_minutes),
             skipped_occurrences = skipped_occurrences + v_missed,
             updated_at = p_now
       where id = r.id;
    end if;
  end loop;

  insert into public.ai_agent_task_trigger_firings (
    account_id,
    trigger_id,
    source_kind,
    source_key,
    business_event_id,
    available_at
  )
  select
    trigger.account_id,
    trigger.id,
    'business_event',
    'event:' || event.id::text,
    event.id,
    p_now
  from public.ai_agent_task_triggers as trigger
  join public.business_event_outbox as event
    on event.account_id = trigger.account_id
   and event.event_type = trigger.event_type
   and event.event_version = trigger.event_version
   and event.created_at >= trigger.created_at
  where trigger.status = 'enabled'
    and trigger.trigger_kind = 'business_event'
    and coalesce((
      select policy.task_worker_enabled
      from public.ai_runtime_policies as policy
      where policy.account_id = trigger.account_id
    ), true)
    and (
      not (trigger.filters ? 'subject_type')
      or event.subject_type = trigger.filters ->> 'subject_type'
    )
    and (
      not (trigger.filters ? 'subject_id')
      or event.subject_id = trigger.filters ->> 'subject_id'
    )
    and (
      not (trigger.filters ? 'payload_contains')
      or (
        jsonb_typeof(trigger.filters -> 'payload_contains') = 'object'
        and event.payload @> (trigger.filters -> 'payload_contains')
      )
    )
    and (
      select count(*) from public.ai_agent_task_trigger_firings as pending
      where pending.account_id = trigger.account_id
        and pending.status in ('pending','claimed','failed')
    ) < coalesce((select policy.agent_task_trigger_max_pending
      from public.ai_runtime_policies as policy
      where policy.account_id = trigger.account_id),100)
    and not exists (
      select 1
      from public.ai_agent_task_trigger_firings as existing
      where existing.trigger_id = trigger.id
        and existing.source_key = 'event:' || event.id::text
    )
  order by event.created_at asc, event.id asc, trigger.id asc
  limit v_limit
  on conflict (trigger_id, source_key) do nothing;

  get diagnostics v_event_count = row_count;

  return jsonb_build_object(
    'schedule_firings', v_schedule_count,
    'schedule_deferred', v_schedule_deferred,
    'business_event_firings', v_event_count
  );
end;
$$;

revoke all on function public.materialize_agent_task_trigger_firings(
  timestamptz,integer
) from public, anon, authenticated;
grant execute on function public.materialize_agent_task_trigger_firings(
  timestamptz,integer
) to service_role;


create or replace function public.claim_next_agent_task_trigger_firing(
  p_worker_id text,
  p_lease_secs integer default 120
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_firing_id uuid;
  v_account_id uuid;
  v_result jsonb;
begin
  if length(btrim(coalesce(p_worker_id, ''))) = 0 then
    raise exception 'AGENT_TASK_TRIGGER_WORKER_ID_REQUIRED';
  end if;
  if length(p_worker_id) > 128 then
    raise exception 'AGENT_TASK_TRIGGER_WORKER_ID_TOO_LONG';
  end if;
  if p_lease_secs < 30 or p_lease_secs > 900 then
    raise exception 'AGENT_TASK_TRIGGER_LEASE_INVALID';
  end if;

  select firing.id, firing.account_id
    into v_firing_id, v_account_id
  from public.ai_agent_task_trigger_firings as firing
  join public.ai_agent_task_triggers as trigger
    on trigger.id = firing.trigger_id
   and trigger.account_id = firing.account_id
  left join public.ai_agent_task_trigger_claim_fairness as fairness
    on fairness.account_id = firing.account_id
  where trigger.status in ('enabled', 'completed')
    and coalesce((
      select policy.task_worker_enabled
      from public.ai_runtime_policies as policy
      where policy.account_id = firing.account_id
    ), true)
    and (
      (
        firing.status in ('pending', 'failed')
        and firing.available_at <= pg_catalog.now()
      )
      or
      (
        firing.status = 'claimed'
        and firing.lease_expires_at is not null
        and firing.lease_expires_at <= pg_catalog.now()
      )
    )
    and firing.attempts < 5
  order by coalesce(fairness.last_claimed_at, '-infinity'::timestamptz) asc,
    firing.available_at asc, firing.created_at asc, firing.id asc
  for update of firing skip locked
  limit 1;

  if v_firing_id is null then
    return null;
  end if;

  update public.ai_agent_task_trigger_firings
     set status = 'claimed',
         attempts = attempts + 1,
         lease_generation = lease_generation + 1,
         claimed_by = btrim(p_worker_id) || ':' || pg_catalog.gen_random_uuid()::text,
         lease_expires_at =
           pg_catalog.now() + make_interval(secs => p_lease_secs),
         last_error = null,
         updated_at = pg_catalog.now()
   where id = v_firing_id;

  insert into public.ai_agent_task_trigger_claim_fairness(account_id,last_claimed_at)
  values (v_account_id,pg_catalog.clock_timestamp())
  on conflict(account_id) do update
    set last_claimed_at = excluded.last_claimed_at;

  select jsonb_build_object(
    'firing_id', firing.id,
    'account_id', firing.account_id,
    'trigger_id', trigger.id,
    'task_type', trigger.task_type,
    'task_type_version', trigger.task_type_version,
    'agent_id', trigger.agent_id,
    'trigger_kind', trigger.trigger_kind,
    'config', trigger.config,
    'filters', trigger.filters,
    'created_by', trigger.created_by,
    'source_key', firing.source_key,
    'scheduled_for', firing.scheduled_for,
    'attempts', firing.attempts,
    'claim_owner', firing.claimed_by,
    'lease_generation', firing.lease_generation,
    'business_event',
      case
        when event.id is null then null
        else jsonb_build_object(
          'id', event.id,
          'event_type', event.event_type,
          'event_version', event.event_version,
          'subject_type', event.subject_type,
          'subject_id', event.subject_id,
          'correlation_id', event.correlation_id,
          'causation_id', event.causation_id,
          'payload', event.payload,
          'created_at', event.created_at
        )
      end
  )
    into v_result
  from public.ai_agent_task_trigger_firings as firing
  join public.ai_agent_task_triggers as trigger
    on trigger.id = firing.trigger_id
   and trigger.account_id = firing.account_id
  left join public.business_event_outbox as event
    on event.id = firing.business_event_id
   and event.account_id = firing.account_id
  where firing.id = v_firing_id;

  return v_result;
end;
$$;

revoke all on function public.claim_next_agent_task_trigger_firing(text,integer)
  from public, anon, authenticated;
grant execute on function public.claim_next_agent_task_trigger_firing(text,integer)
  to service_role;

