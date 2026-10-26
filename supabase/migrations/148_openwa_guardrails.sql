-- OW-10: OpenWA safety and anti-abuse guardrails.
-- Server-only state; all decisions are account + connection scoped.

create table if not exists public.whatsapp_connection_guardrails (
  connection_id uuid primary key references public.whatsapp_connections(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  manual_paused boolean not null default false,
  hourly_cap integer not null default 60 check (hourly_cap between 1 and 10000),
  daily_cap integer not null default 500 check (daily_cap between 1 and 100000),
  first_touch_daily_cap integer not null default 100 check (first_touch_daily_cap between 0 and 100000),
  minimum_interval_ms integer not null default 1500 check (minimum_interval_ms between 0 and 600000),
  jitter_ms integer not null default 1000 check (jitter_ms between 0 and 600000),
  warmup_until timestamptz,
  warmup_hourly_cap integer not null default 20 check (warmup_hourly_cap between 1 and 10000),
  warmup_daily_cap integer not null default 100 check (warmup_daily_cap between 1 and 100000),
  failure_window_minutes integer not null default 15 check (failure_window_minutes between 1 and 1440),
  failure_min_attempts integer not null default 10 check (failure_min_attempts between 1 and 10000),
  failure_rate_threshold numeric(5,4) not null default 0.5000 check (failure_rate_threshold > 0 and failure_rate_threshold <= 1),
  circuit_open_until timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.whatsapp_guardrail_events (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  connection_id uuid not null references public.whatsapp_connections(id) on delete cascade,
  recipient_hash text,
  workload text not null check (workload in ('manual','automation','broadcast','agent','api')),
  decision text not null check (decision in ('reserved','blocked','success','failure','paused','resumed','circuit_opened','circuit_reset')),
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists whatsapp_guardrail_events_scope_time_idx on public.whatsapp_guardrail_events(account_id, connection_id, created_at desc);
create index if not exists whatsapp_guardrail_events_recipient_idx on public.whatsapp_guardrail_events(account_id, connection_id, recipient_hash, created_at desc) where recipient_hash is not null;

alter table public.whatsapp_connection_guardrails enable row level security;
alter table public.whatsapp_guardrail_events enable row level security;
revoke all on public.whatsapp_connection_guardrails from anon, authenticated;
revoke all on public.whatsapp_guardrail_events from anon, authenticated;
grant all on public.whatsapp_connection_guardrails to service_role;
grant all on public.whatsapp_guardrail_events to service_role;

create or replace function public.reserve_openwa_guardrail_send(
  p_account_id uuid,
  p_connection_id uuid,
  p_recipient_hash text,
  p_workload text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn record;
  v_cfg public.whatsapp_connection_guardrails%rowtype;
  v_hour_count integer;
  v_day_count integer;
  v_first_touch_count integer;
  v_is_first_touch boolean;
  v_hour_cap integer;
  v_day_cap integer;
  v_last_reserved timestamptz;
  v_wait_ms integer := 0;
begin
  if p_workload not in ('manual','automation','broadcast','agent','api') then
    raise exception 'invalid guardrail workload';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_account_id::text || ':' || p_connection_id::text));

  select id, account_id, provider, status, connected_at into v_conn
  from public.whatsapp_connections
  where id = p_connection_id and account_id = p_account_id;

  if not found or v_conn.provider <> 'openwa' then
    return jsonb_build_object('allowed', false, 'reason', 'connection_scope_mismatch');
  end if;
  if v_conn.status not in ('connected','ready') then
    insert into public.whatsapp_guardrail_events(account_id, connection_id, recipient_hash, workload, decision, reason)
    values (p_account_id, p_connection_id, p_recipient_hash, p_workload, 'blocked', 'connection_' || coalesce(v_conn.status,'unknown'));
    return jsonb_build_object('allowed', false, 'reason', 'connection_restricted');
  end if;

  insert into public.whatsapp_connection_guardrails(connection_id, account_id, warmup_until)
  values (p_connection_id, p_account_id, coalesce(v_conn.connected_at, now()) + interval '7 days')
  on conflict (connection_id) do nothing;

  select * into v_cfg from public.whatsapp_connection_guardrails
  where connection_id = p_connection_id and account_id = p_account_id for update;

  if v_cfg.manual_paused then
    insert into public.whatsapp_guardrail_events(account_id, connection_id, recipient_hash, workload, decision, reason)
    values (p_account_id, p_connection_id, p_recipient_hash, p_workload, 'blocked', 'manual_pause');
    return jsonb_build_object('allowed', false, 'reason', 'manual_pause');
  end if;
  if v_cfg.circuit_open_until is not null and v_cfg.circuit_open_until > now() then
    insert into public.whatsapp_guardrail_events(account_id, connection_id, recipient_hash, workload, decision, reason)
    values (p_account_id, p_connection_id, p_recipient_hash, p_workload, 'blocked', 'failure_circuit_open');
    return jsonb_build_object('allowed', false, 'reason', 'failure_circuit_open');
  end if;

  v_hour_cap := case when v_cfg.warmup_until > now() then least(v_cfg.hourly_cap, v_cfg.warmup_hourly_cap) else v_cfg.hourly_cap end;
  v_day_cap := case when v_cfg.warmup_until > now() then least(v_cfg.daily_cap, v_cfg.warmup_daily_cap) else v_cfg.daily_cap end;

  select count(*) into v_hour_count from public.whatsapp_guardrail_events
    where account_id=p_account_id and connection_id=p_connection_id and decision='reserved' and created_at >= now()-interval '1 hour';
  select count(*) into v_day_count from public.whatsapp_guardrail_events
    where account_id=p_account_id and connection_id=p_connection_id and decision='reserved' and created_at >= now()-interval '24 hours';
  if v_hour_count >= v_hour_cap or v_day_count >= v_day_cap then
    insert into public.whatsapp_guardrail_events(account_id, connection_id, recipient_hash, workload, decision, reason)
    values (p_account_id, p_connection_id, p_recipient_hash, p_workload, 'blocked', case when v_hour_count >= v_hour_cap then 'hourly_cap' else 'daily_cap' end);
    return jsonb_build_object('allowed', false, 'reason', case when v_hour_count >= v_hour_cap then 'hourly_cap' else 'daily_cap' end);
  end if;

  select not exists(select 1 from public.whatsapp_guardrail_events where account_id=p_account_id and connection_id=p_connection_id and recipient_hash=p_recipient_hash and decision in ('reserved','success') and created_at < now()) into v_is_first_touch;
  if v_is_first_touch then
    select count(distinct recipient_hash) into v_first_touch_count from public.whatsapp_guardrail_events
      where account_id=p_account_id and connection_id=p_connection_id and decision='reserved' and created_at >= now()-interval '24 hours';
    if v_first_touch_count >= v_cfg.first_touch_daily_cap then
      insert into public.whatsapp_guardrail_events(account_id, connection_id, recipient_hash, workload, decision, reason)
      values (p_account_id, p_connection_id, p_recipient_hash, p_workload, 'blocked', 'first_touch_daily_cap');
      return jsonb_build_object('allowed', false, 'reason', 'first_touch_daily_cap');
    end if;
  end if;

  if p_workload <> 'manual' then
    select max(created_at) into v_last_reserved from public.whatsapp_guardrail_events
      where account_id=p_account_id and connection_id=p_connection_id and decision='reserved';
    if v_last_reserved is not null then
      v_wait_ms := greatest(0, v_cfg.minimum_interval_ms - floor(extract(epoch from (now()-v_last_reserved))*1000)::integer);
    end if;
    if v_cfg.jitter_ms > 0 then v_wait_ms := v_wait_ms + floor(random() * (v_cfg.jitter_ms + 1))::integer; end if;
  end if;

  insert into public.whatsapp_guardrail_events(account_id, connection_id, recipient_hash, workload, decision, reason)
  values (p_account_id, p_connection_id, p_recipient_hash, p_workload, 'reserved', case when v_cfg.warmup_until > now() then 'warmup' else null end);
  return jsonb_build_object('allowed', true, 'wait_ms', v_wait_ms, 'warmup', v_cfg.warmup_until > now());
end $$;

create or replace function public.record_openwa_guardrail_outcome(
  p_account_id uuid, p_connection_id uuid, p_recipient_hash text, p_workload text, p_success boolean, p_reason text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_cfg public.whatsapp_connection_guardrails%rowtype; v_attempts integer; v_failures integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_account_id::text || ':' || p_connection_id::text));
  select * into v_cfg from public.whatsapp_connection_guardrails where connection_id=p_connection_id and account_id=p_account_id for update;
  if not found then return; end if;
  insert into public.whatsapp_guardrail_events(account_id,connection_id,recipient_hash,workload,decision,reason)
  values(p_account_id,p_connection_id,p_recipient_hash,p_workload,case when p_success then 'success' else 'failure' end,left(p_reason,160));
  select count(*), count(*) filter (where decision='failure') into v_attempts,v_failures
  from public.whatsapp_guardrail_events where account_id=p_account_id and connection_id=p_connection_id and decision in ('success','failure') and created_at >= now()-(v_cfg.failure_window_minutes || ' minutes')::interval;
  if v_attempts >= v_cfg.failure_min_attempts and v_failures::numeric/v_attempts >= v_cfg.failure_rate_threshold then
    update public.whatsapp_connection_guardrails set circuit_open_until=now()+interval '15 minutes', updated_at=now() where connection_id=p_connection_id and account_id=p_account_id;
    insert into public.whatsapp_guardrail_events(account_id,connection_id,workload,decision,reason) values(p_account_id,p_connection_id,p_workload,'circuit_opened','failure_rate');
  end if;
end $$;

revoke all on function public.reserve_openwa_guardrail_send(uuid,uuid,text,text) from public, anon, authenticated;
revoke all on function public.record_openwa_guardrail_outcome(uuid,uuid,text,text,boolean,text) from public, anon, authenticated;
grant execute on function public.reserve_openwa_guardrail_send(uuid,uuid,text,text) to service_role;
grant execute on function public.record_openwa_guardrail_outcome(uuid,uuid,text,text,boolean,text) to service_role;
