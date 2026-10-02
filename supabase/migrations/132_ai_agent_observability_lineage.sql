-- ============================================================
-- 132_ai_agent_observability_lineage.sql
-- Phase 15: append-only runtime incidents + generic business-outcome lineage.
-- ============================================================

create table public.ai_agent_business_outcome_links (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  run_id uuid not null,
  task_id uuid,
  task_target_id uuid,
  outcome_type text not null
    check (outcome_type ~ '^[a-z][a-z0-9_]*$'),
  outcome_id text not null
    check (length(btrim(outcome_id)) between 1 and 200),
  outcome_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ai_agent_business_outcome_links_account_run_fk
    foreign key (account_id, run_id)
    references public.ai_agent_runs(account_id, id)
    on delete cascade,
  constraint ai_agent_business_outcome_links_account_task_fk
    foreign key (account_id, task_id)
    references public.ai_agent_tasks(account_id, id)
    on delete cascade,
  constraint ai_agent_business_outcome_links_account_target_fk
    foreign key (account_id, task_id, task_target_id)
    references public.ai_agent_task_targets(account_id, task_id, id)
    on delete cascade,
  unique (account_id, run_id, outcome_type, outcome_id)
);

create index ai_agent_business_outcome_links_task_idx
  on public.ai_agent_business_outcome_links(
    account_id, task_id, created_at, id
  )
  where task_id is not null;

create index ai_agent_business_outcome_links_target_idx
  on public.ai_agent_business_outcome_links(
    account_id, task_id, task_target_id, created_at, id
  )
  where task_target_id is not null;

alter table public.ai_agent_business_outcome_links enable row level security;
revoke all on table public.ai_agent_business_outcome_links
  from public,anon,authenticated;
grant select,insert,update,delete on table public.ai_agent_business_outcome_links
  to service_role;

create or replace function public.link_ai_agent_business_outcome(
  p_account_id uuid,
  p_run_id uuid,
  p_outcome_type text,
  p_outcome_id text,
  p_outcome_status text default null
) returns uuid
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_run public.ai_agent_runs%rowtype;
  v_id uuid;
begin
  if p_outcome_type is null
     or p_outcome_type !~ '^[a-z][a-z0-9_]*$'
     or length(btrim(coalesce(p_outcome_id,''))) not between 1 and 200 then
    raise exception 'AI_BUSINESS_OUTCOME_LINK_INVALID';
  end if;

  select run.*
    into v_run
  from public.ai_agent_runs as run
  where run.account_id=p_account_id
    and run.id=p_run_id;

  if v_run.id is null then
    raise exception 'AI_BUSINESS_OUTCOME_RUN_NOT_FOUND';
  end if;

  insert into public.ai_agent_business_outcome_links as link (
    account_id,
    run_id,
    task_id,
    task_target_id,
    outcome_type,
    outcome_id,
    outcome_status
  ) values (
    p_account_id,
    p_run_id,
    v_run.task_id,
    v_run.task_target_id,
    p_outcome_type,
    btrim(p_outcome_id),
    nullif(btrim(coalesce(p_outcome_status,'')),'')
  )
  on conflict (account_id,run_id,outcome_type,outcome_id)
  do update set
    outcome_status=coalesce(
      excluded.outcome_status,
      link.outcome_status
    ),
    updated_at=pg_catalog.now()
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.link_ai_agent_business_outcome(
  uuid,uuid,text,text,text
) from public,anon,authenticated;
grant execute on function public.link_ai_agent_business_outcome(
  uuid,uuid,text,text,text
) to service_role;

create or replace function public.link_business_event_to_agent_run()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_source_run_id uuid;
begin
  if nullif(new.correlation_id,'') is null then
    return new;
  end if;

  select change.source_run_id
    into v_source_run_id
  from public.change_requests as change
  where change.account_id=new.account_id
    and change.id::text=new.correlation_id
    and change.source_run_id is not null
  limit 1;

  if v_source_run_id is null then
    return new;
  end if;

  perform public.link_ai_agent_business_outcome(
    new.account_id,
    v_source_run_id,
    'business_event',
    new.id::text,
    new.status
  );

  return new;
end;
$$;

revoke all on function public.link_business_event_to_agent_run()
  from public,anon,authenticated;

drop trigger if exists business_event_outbox_agent_run_lineage
  on public.business_event_outbox;
create trigger business_event_outbox_agent_run_lineage
  after insert or update of correlation_id,status
  on public.business_event_outbox
  for each row
  execute function public.link_business_event_to_agent_run();

create table public.ai_agent_circuit_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  run_id uuid,
  task_id uuid,
  scope_type text not null
    check (scope_type in ('provider','tool','channel','task_type')),
  scope_key text not null check (length(btrim(scope_key)) > 0),
  outcome text not null check (outcome in ('success','failure','rejection')),
  error_code text,
  state_after text not null check (state_after in ('closed','open')),
  failure_count integer not null default 0 check (failure_count >= 0),
  rejection_count integer not null default 0 check (rejection_count >= 0),
  success_count integer not null default 0 check (success_count >= 0),
  blocked_until timestamptz,
  created_at timestamptz not null default now(),

  constraint ai_agent_circuit_events_account_run_fk
    foreign key (account_id, run_id)
    references public.ai_agent_runs(account_id, id)
    on delete cascade,
  constraint ai_agent_circuit_events_account_task_fk
    foreign key (account_id, task_id)
    references public.ai_agent_tasks(account_id, id)
    on delete cascade
);

create index ai_agent_circuit_events_account_scope_idx
  on public.ai_agent_circuit_events(
    account_id, scope_type, created_at desc, id
  );

create index ai_agent_circuit_events_task_idx
  on public.ai_agent_circuit_events(
    account_id, task_id, created_at desc, id
  )
  where task_id is not null;

alter table public.ai_agent_circuit_events enable row level security;
revoke all on table public.ai_agent_circuit_events
  from public,anon,authenticated;
grant select,insert on table public.ai_agent_circuit_events to service_role;

create or replace function public.record_ai_agent_circuit_event_v2(
  p_account_id uuid,
  p_scope_type text,
  p_scope_key text,
  p_outcome text,
  p_error_code text default null,
  p_run_id uuid default null,
  p_task_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  v_state jsonb;
  v_run public.ai_agent_runs%rowtype;
  v_effective_task_id uuid := p_task_id;
begin
  if p_run_id is not null then
    select run.*
      into v_run
    from public.ai_agent_runs as run
    where run.account_id=p_account_id
      and run.id=p_run_id;

    if v_run.id is null then
      raise exception 'AI_CIRCUIT_EVENT_RUN_NOT_FOUND';
    end if;

    if v_effective_task_id is null then
      v_effective_task_id:=v_run.task_id;
    elsif v_run.task_id is distinct from v_effective_task_id then
      raise exception 'AI_CIRCUIT_EVENT_TASK_MISMATCH';
    end if;
  end if;

  if v_effective_task_id is not null
     and not exists (
       select 1
       from public.ai_agent_tasks as task
       where task.account_id=p_account_id
         and task.id=v_effective_task_id
     ) then
    raise exception 'AI_CIRCUIT_EVENT_TASK_NOT_FOUND';
  end if;

  v_state:=public.record_ai_agent_circuit_event(
    p_account_id,
    p_scope_type,
    p_scope_key,
    p_outcome,
    p_error_code
  );

  insert into public.ai_agent_circuit_events (
    account_id,
    run_id,
    task_id,
    scope_type,
    scope_key,
    outcome,
    error_code,
    state_after,
    failure_count,
    rejection_count,
    success_count,
    blocked_until
  ) values (
    p_account_id,
    p_run_id,
    v_effective_task_id,
    p_scope_type,
    btrim(p_scope_key),
    p_outcome,
    nullif(left(btrim(coalesce(p_error_code,'')),120),''),
    case when v_state->>'state'='open' then 'open' else 'closed' end,
    greatest(coalesce((v_state->>'failure_count')::integer,0),0),
    greatest(coalesce((v_state->>'rejection_count')::integer,0),0),
    greatest(coalesce((v_state->>'success_count')::integer,0),0),
    case
      when nullif(v_state->>'blocked_until','') is null then null
      else (v_state->>'blocked_until')::timestamptz
    end
  );

  return v_state;
end;
$$;

revoke all on function public.record_ai_agent_circuit_event_v2(
  uuid,text,text,text,text,uuid,uuid
) from public,anon,authenticated;
grant execute on function public.record_ai_agent_circuit_event_v2(
  uuid,text,text,text,text,uuid,uuid
) to service_role;
