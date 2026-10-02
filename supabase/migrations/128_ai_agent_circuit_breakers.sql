-- ============================================================
-- 128_ai_agent_circuit_breakers.sql
-- Phase 14: generic provider/tool/channel/task-type circuit breakers.
-- ============================================================

create table public.ai_agent_circuit_breakers (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  scope_type text not null
    check (scope_type in ('provider','tool','channel','task_type')),
  scope_key text not null check (length(btrim(scope_key)) > 0),
  state text not null default 'closed'
    check (state in ('closed','open')),
  failure_threshold integer not null default 5
    check (failure_threshold between 1 and 1000),
  rejection_threshold integer not null default 10
    check (rejection_threshold between 1 and 10000),
  window_seconds integer not null default 300
    check (window_seconds between 30 and 86400),
  cooldown_seconds integer not null default 300
    check (cooldown_seconds between 30 and 86400),
  failure_count integer not null default 0 check (failure_count >= 0),
  rejection_count integer not null default 0 check (rejection_count >= 0),
  success_count integer not null default 0 check (success_count >= 0),
  window_started_at timestamptz not null default now(),
  opened_at timestamptz,
  blocked_until timestamptz,
  last_error_code text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, scope_type, scope_key)
);

create index ai_agent_circuit_breakers_open_idx
  on public.ai_agent_circuit_breakers(account_id, blocked_until, scope_type)
  where state='open';

alter table public.ai_agent_circuit_breakers enable row level security;

create policy ai_agent_circuit_breakers_select
  on public.ai_agent_circuit_breakers
  for select
  using (is_account_member(account_id, 'admin'));

create policy ai_agent_circuit_breakers_insert
  on public.ai_agent_circuit_breakers
  for insert
  with check (is_account_member(account_id, 'admin'));

create policy ai_agent_circuit_breakers_update
  on public.ai_agent_circuit_breakers
  for update
  using (is_account_member(account_id, 'admin'))
  with check (is_account_member(account_id, 'admin'));

create policy ai_agent_circuit_breakers_delete
  on public.ai_agent_circuit_breakers
  for delete
  using (is_account_member(account_id, 'admin'));

revoke all on table public.ai_agent_circuit_breakers from anon, authenticated;
grant select, insert, update, delete
  on table public.ai_agent_circuit_breakers to authenticated;
grant all on table public.ai_agent_circuit_breakers to service_role;

create or replace function public.update_ai_agent_circuit_breakers_updated_at()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  new.updated_at=now();
  return new;
end;
$$;

create trigger ai_agent_circuit_breakers_updated_at
  before update on public.ai_agent_circuit_breakers
  for each row execute function public.update_ai_agent_circuit_breakers_updated_at();

create or replace function public.check_ai_agent_circuit_breaker(
  p_account_id uuid,
  p_scope_type text,
  p_scope_key text
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_row public.ai_agent_circuit_breakers%rowtype;
begin
  if p_scope_type not in ('provider','tool','channel','task_type')
     or length(btrim(coalesce(p_scope_key,'')))=0 then
    raise exception 'AI_CIRCUIT_SCOPE_INVALID';
  end if;

  select * into v_row
  from public.ai_agent_circuit_breakers
  where account_id=p_account_id
    and scope_type=p_scope_type
    and scope_key=btrim(p_scope_key)
  for update;

  if v_row.id is null then
    return jsonb_build_object(
      'open',false,
      'state','closed',
      'scope_type',p_scope_type,
      'scope_key',btrim(p_scope_key)
    );
  end if;

  if v_row.state='open'
     and v_row.blocked_until is not null
     and v_row.blocked_until<=now() then
    update public.ai_agent_circuit_breakers
    set state='closed',
        failure_count=0,
        rejection_count=0,
        success_count=0,
        window_started_at=now(),
        opened_at=null,
        blocked_until=null,
        last_error_code=null
    where id=v_row.id
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'open',v_row.state='open',
    'state',v_row.state,
    'scope_type',v_row.scope_type,
    'scope_key',v_row.scope_key,
    'blocked_until',v_row.blocked_until,
    'failure_count',v_row.failure_count,
    'rejection_count',v_row.rejection_count,
    'success_count',v_row.success_count
  );
end;
$$;

revoke all on function public.check_ai_agent_circuit_breaker(uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.check_ai_agent_circuit_breaker(uuid,text,text)
  to service_role;

create or replace function public.record_ai_agent_circuit_event(
  p_account_id uuid,
  p_scope_type text,
  p_scope_key text,
  p_outcome text,
  p_error_code text default null
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_row public.ai_agent_circuit_breakers%rowtype;
begin
  if p_scope_type not in ('provider','tool','channel','task_type')
     or length(btrim(coalesce(p_scope_key,'')))=0 then
    raise exception 'AI_CIRCUIT_SCOPE_INVALID';
  end if;
  if p_outcome not in ('success','failure','rejection') then
    raise exception 'AI_CIRCUIT_OUTCOME_INVALID';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      p_account_id::text||':'||p_scope_type||':'||btrim(p_scope_key),
      6514
    )
  );

  insert into public.ai_agent_circuit_breakers(
    account_id,scope_type,scope_key
  ) values (
    p_account_id,p_scope_type,btrim(p_scope_key)
  )
  on conflict (account_id,scope_type,scope_key) do nothing;

  select * into v_row
  from public.ai_agent_circuit_breakers
  where account_id=p_account_id
    and scope_type=p_scope_type
    and scope_key=btrim(p_scope_key)
  for update;

  if v_row.state='open'
     and v_row.blocked_until is not null
     and v_row.blocked_until>now() then
    return jsonb_build_object(
      'open',true,
      'state','open',
      'blocked_until',v_row.blocked_until,
      'failure_count',v_row.failure_count,
      'rejection_count',v_row.rejection_count
    );
  end if;

  if v_row.window_started_at
       + make_interval(secs=>v_row.window_seconds)<=now()
     or (
       v_row.state='open'
       and v_row.blocked_until is not null
       and v_row.blocked_until<=now()
     ) then
    update public.ai_agent_circuit_breakers
    set state='closed',
        failure_count=0,
        rejection_count=0,
        success_count=0,
        window_started_at=now(),
        opened_at=null,
        blocked_until=null,
        last_error_code=null
    where id=v_row.id
    returning * into v_row;
  end if;

  update public.ai_agent_circuit_breakers
  set failure_count=
        failure_count + case when p_outcome='failure' then 1 else 0 end,
      rejection_count=
        rejection_count + case when p_outcome='rejection' then 1 else 0 end,
      success_count=
        success_count + case when p_outcome='success' then 1 else 0 end,
      last_error_code=
        case
          when p_outcome='success' then last_error_code
          else left(nullif(btrim(coalesce(p_error_code,'')),''),120)
        end
  where id=v_row.id
  returning * into v_row;

  if v_row.failure_count>=v_row.failure_threshold
     or v_row.rejection_count>=v_row.rejection_threshold then
    update public.ai_agent_circuit_breakers
    set state='open',
        opened_at=now(),
        blocked_until=now()+make_interval(secs=>cooldown_seconds)
    where id=v_row.id
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'open',v_row.state='open',
    'state',v_row.state,
    'blocked_until',v_row.blocked_until,
    'failure_count',v_row.failure_count,
    'rejection_count',v_row.rejection_count,
    'success_count',v_row.success_count
  );
end;
$$;

revoke all on function public.record_ai_agent_circuit_event(
  uuid,text,text,text,text
) from public,anon,authenticated;
grant execute on function public.record_ai_agent_circuit_event(
  uuid,text,text,text,text
) to service_role;
