-- ============================================================
-- 124_ai_agent_task_triggers.sql
-- Phase 13: durable one-time / recurring schedules and Business Event
-- trigger firings for the generic Agent Task Platform.
--
-- Business domains still own task semantics. This migration only owns:
--   trigger policy persistence -> deterministic firing identity -> leases/retry.
-- No trigger invokes an Agent directly and no WhatsApp transport is touched.
-- ============================================================

create table public.ai_agent_task_triggers (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  task_type text not null,
  task_type_version integer not null check (task_type_version > 0),
  agent_id uuid not null references public.ai_agents(id) on delete cascade,

  trigger_kind text not null
    check (trigger_kind in ('schedule', 'business_event')),
  status text not null default 'enabled'
    check (status in ('enabled', 'paused', 'completed')),

  schedule_kind text
    check (schedule_kind is null or schedule_kind in ('once', 'recurring')),
  next_fire_at timestamptz,
  interval_minutes integer
    check (
      interval_minutes is null
      or interval_minutes between 5 and 525600
    ),

  event_type text,
  event_version integer
    check (event_version is null or event_version > 0),

  config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(config) = 'object'),
  filters jsonb not null default '{}'::jsonb
    check (jsonb_typeof(filters) = 'object'),

  idempotency_key text not null
    check (char_length(idempotency_key) between 16 and 500),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ai_agent_task_triggers_shape_check check (
    (
      trigger_kind = 'schedule'
      and schedule_kind is not null
      and next_fire_at is not null
      and event_type is null
      and event_version is null
      and (
        (schedule_kind = 'once' and interval_minutes is null)
        or
        (schedule_kind = 'recurring' and interval_minutes is not null)
      )
    )
    or
    (
      trigger_kind = 'business_event'
      and schedule_kind is null
      and next_fire_at is null
      and interval_minutes is null
      and event_type is not null
      and event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
      and event_version is not null
    )
  )
);

create unique index ai_agent_task_triggers_account_idempotency_uidx
  on public.ai_agent_task_triggers(account_id, idempotency_key);

create index ai_agent_task_triggers_schedule_due_idx
  on public.ai_agent_task_triggers(status, next_fire_at, id)
  where trigger_kind = 'schedule' and status = 'enabled';

create index ai_agent_task_triggers_event_idx
  on public.ai_agent_task_triggers(
    account_id, event_type, event_version, created_at, id
  )
  where trigger_kind = 'business_event' and status = 'enabled';

alter table public.ai_agent_task_triggers enable row level security;
revoke all on table public.ai_agent_task_triggers
  from public, anon, authenticated;
grant select, insert, update, delete on table public.ai_agent_task_triggers
  to service_role;

create table public.ai_agent_task_trigger_firings (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  trigger_id uuid not null
    references public.ai_agent_task_triggers(id) on delete cascade,

  source_kind text not null
    check (source_kind in ('schedule', 'business_event')),
  source_key text not null
    check (char_length(source_key) between 8 and 500),
  scheduled_for timestamptz,
  business_event_id uuid
    references public.business_event_outbox(id) on delete cascade,

  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'failed', 'completed', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  claimed_by text,
  lease_expires_at timestamptz,
  task_id uuid references public.ai_agent_tasks(id) on delete set null,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ai_agent_task_trigger_firings_source_shape_check check (
    (
      source_kind = 'schedule'
      and scheduled_for is not null
      and business_event_id is null
    )
    or
    (
      source_kind = 'business_event'
      and scheduled_for is null
      and business_event_id is not null
    )
  )
);

create unique index ai_agent_task_trigger_firings_source_uidx
  on public.ai_agent_task_trigger_firings(trigger_id, source_key);

create index ai_agent_task_trigger_firings_queue_idx
  on public.ai_agent_task_trigger_firings(
    status, available_at, lease_expires_at, created_at, id
  );

alter table public.ai_agent_task_trigger_firings enable row level security;
revoke all on table public.ai_agent_task_trigger_firings
  from public, anon, authenticated;
grant select, insert, update, delete on table public.ai_agent_task_trigger_firings
  to service_role;

create or replace function public.create_agent_task_trigger(
  p_account_id uuid,
  p_task_type text,
  p_task_type_version integer,
  p_agent_id uuid,
  p_trigger_kind text,
  p_schedule_kind text,
  p_next_fire_at timestamptz,
  p_interval_minutes integer,
  p_event_type text,
  p_event_version integer,
  p_config jsonb,
  p_filters jsonb,
  p_idempotency_key text,
  p_created_by uuid
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_existing uuid;
  v_trigger_id uuid;
begin
  if length(btrim(coalesce(p_task_type, ''))) = 0
     or coalesce(p_task_type_version, 0) < 1 then
    raise exception 'AGENT_TASK_TRIGGER_TASK_TYPE_INVALID';
  end if;

  if not exists (
    select 1
    from public.ai_agents as agent
    where agent.account_id = p_account_id
      and agent.id = p_agent_id
      and agent.status = 'active'
  ) then
    raise exception 'AGENT_TASK_TRIGGER_AGENT_NOT_ACTIVE';
  end if;

  if p_config is null or jsonb_typeof(p_config) <> 'object'
     or p_filters is null or jsonb_typeof(p_filters) <> 'object' then
    raise exception 'AGENT_TASK_TRIGGER_POLICY_OBJECT_REQUIRED';
  end if;

  if length(btrim(coalesce(p_idempotency_key, ''))) < 16
     or length(p_idempotency_key) > 500 then
    raise exception 'AGENT_TASK_TRIGGER_IDEMPOTENCY_KEY_INVALID';
  end if;

  if p_trigger_kind = 'schedule' then
    if p_schedule_kind not in ('once', 'recurring')
       or p_next_fire_at is null
       or p_event_type is not null
       or p_event_version is not null then
      raise exception 'AGENT_TASK_SCHEDULE_TRIGGER_INVALID';
    end if;
    if p_schedule_kind = 'once' and p_interval_minutes is not null then
      raise exception 'AGENT_TASK_ONCE_TRIGGER_INTERVAL_FORBIDDEN';
    end if;
    if p_schedule_kind = 'recurring'
       and (
         p_interval_minutes is null
         or p_interval_minutes < 5
         or p_interval_minutes > 525600
       ) then
      raise exception 'AGENT_TASK_RECURRING_INTERVAL_INVALID';
    end if;
  elsif p_trigger_kind = 'business_event' then
    if p_schedule_kind is not null
       or p_next_fire_at is not null
       or p_interval_minutes is not null
       or p_event_type is null
       or p_event_type !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
       or coalesce(p_event_version, 0) < 1 then
      raise exception 'AGENT_TASK_BUSINESS_EVENT_TRIGGER_INVALID';
    end if;
  else
    raise exception 'AGENT_TASK_TRIGGER_KIND_INVALID';
  end if;

  select id
    into v_existing
  from public.ai_agent_task_triggers
  where account_id = p_account_id
    and idempotency_key = btrim(p_idempotency_key);

  if v_existing is not null then
    return v_existing;
  end if;

  insert into public.ai_agent_task_triggers (
    account_id,
    task_type,
    task_type_version,
    agent_id,
    trigger_kind,
    schedule_kind,
    next_fire_at,
    interval_minutes,
    event_type,
    event_version,
    config,
    filters,
    idempotency_key,
    created_by
  ) values (
    p_account_id,
    btrim(p_task_type),
    p_task_type_version,
    p_agent_id,
    p_trigger_kind,
    p_schedule_kind,
    p_next_fire_at,
    p_interval_minutes,
    p_event_type,
    p_event_version,
    p_config,
    p_filters,
    btrim(p_idempotency_key),
    p_created_by
  )
  on conflict (account_id, idempotency_key) do nothing
  returning id into v_trigger_id;

  if v_trigger_id is null then
    select id
      into v_trigger_id
    from public.ai_agent_task_triggers
    where account_id = p_account_id
      and idempotency_key = btrim(p_idempotency_key);
  end if;

  if v_trigger_id is null then
    raise exception 'AGENT_TASK_TRIGGER_CREATE_FAILED';
  end if;

  return v_trigger_id;
end;
$$;

revoke all on function public.create_agent_task_trigger(
  uuid,text,integer,uuid,text,text,timestamptz,integer,text,integer,
  jsonb,jsonb,text,uuid
) from public, anon, authenticated;
grant execute on function public.create_agent_task_trigger(
  uuid,text,integer,uuid,text,text,timestamptz,integer,text,integer,
  jsonb,jsonb,text,uuid
) to service_role;

create or replace function public.set_agent_task_trigger_status(
  p_account_id uuid,
  p_trigger_id uuid,
  p_status text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_status not in ('enabled', 'paused') then
    raise exception 'AGENT_TASK_TRIGGER_STATUS_INVALID';
  end if;

  update public.ai_agent_task_triggers
     set status = p_status,
         updated_at = pg_catalog.now()
   where id = p_trigger_id
     and account_id = p_account_id
     and status <> 'completed';

  return found;
end;
$$;

revoke all on function public.set_agent_task_trigger_status(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.set_agent_task_trigger_status(uuid,uuid,text)
  to service_role;

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
begin
  for r in
    select trigger.*
    from public.ai_agent_task_triggers as trigger
    where trigger.status = 'enabled'
      and trigger.trigger_kind = 'schedule'
      and trigger.next_fire_at is not null
      and trigger.next_fire_at <= p_now
    order by trigger.next_fire_at asc, trigger.id asc
    for update skip locked
    limit v_limit
  loop
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
      'schedule:' || r.id::text || ':' ||
        to_char(r.next_fire_at at time zone 'UTC', 'YYYYMMDD"T"HH24MISS.US'),
      r.next_fire_at,
      p_now
    )
    on conflict (trigger_id, source_key) do nothing;

    if found then
      v_schedule_count := v_schedule_count + 1;
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
               r.next_fire_at +
               make_interval(mins => r.interval_minutes),
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
  v_result jsonb;
begin
  if length(btrim(coalesce(p_worker_id, ''))) = 0 then
    raise exception 'AGENT_TASK_TRIGGER_WORKER_ID_REQUIRED';
  end if;
  if p_lease_secs < 30 or p_lease_secs > 900 then
    raise exception 'AGENT_TASK_TRIGGER_LEASE_INVALID';
  end if;

  select firing.id
    into v_firing_id
  from public.ai_agent_task_trigger_firings as firing
  join public.ai_agent_task_triggers as trigger
    on trigger.id = firing.trigger_id
   and trigger.account_id = firing.account_id
  where trigger.status in ('enabled', 'completed')
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
  order by firing.available_at asc, firing.created_at asc, firing.id asc
  for update of firing skip locked
  limit 1;

  if v_firing_id is null then
    return null;
  end if;

  update public.ai_agent_task_trigger_firings
     set status = 'claimed',
         attempts = attempts + 1,
         claimed_by = btrim(p_worker_id),
         lease_expires_at =
           pg_catalog.now() + make_interval(secs => p_lease_secs),
         last_error = null,
         updated_at = pg_catalog.now()
   where id = v_firing_id;

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

create or replace function public.complete_agent_task_trigger_firing(
  p_firing_id uuid,
  p_worker_id text,
  p_task_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.ai_agent_task_trigger_firings
     set status = 'completed',
         task_id = p_task_id,
         claimed_by = null,
         lease_expires_at = null,
         last_error = null,
         updated_at = pg_catalog.now()
   where id = p_firing_id
     and status = 'claimed'
     and claimed_by = p_worker_id;

  return found;
end;
$$;

revoke all on function public.complete_agent_task_trigger_firing(uuid,text,uuid)
  from public, anon, authenticated;
grant execute on function public.complete_agent_task_trigger_firing(uuid,text,uuid)
  to service_role;

create or replace function public.fail_agent_task_trigger_firing(
  p_firing_id uuid,
  p_worker_id text,
  p_error text,
  p_delay_secs integer default 60
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_attempts integer;
  v_status text;
begin
  if p_delay_secs < 0 or p_delay_secs > 86400 then
    raise exception 'AGENT_TASK_TRIGGER_RETRY_DELAY_INVALID';
  end if;

  select attempts
    into v_attempts
  from public.ai_agent_task_trigger_firings
  where id = p_firing_id
    and status = 'claimed'
    and claimed_by = p_worker_id
  for update;

  if v_attempts is null then
    return null;
  end if;

  v_status := case when v_attempts >= 5 then 'dead' else 'failed' end;

  update public.ai_agent_task_trigger_firings
     set status = v_status,
         available_at =
           case
             when v_status = 'failed'
               then pg_catalog.now() + make_interval(secs => p_delay_secs)
             else available_at
           end,
         claimed_by = null,
         lease_expires_at = null,
         last_error = left(coalesce(p_error, 'AGENT_TASK_TRIGGER_FAILED'), 1000),
         updated_at = pg_catalog.now()
   where id = p_firing_id;

  return v_status;
end;
$$;

revoke all on function public.fail_agent_task_trigger_firing(
  uuid,text,text,integer
) from public, anon, authenticated;
grant execute on function public.fail_agent_task_trigger_firing(
  uuid,text,text,integer
) to service_role;
