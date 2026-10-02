-- ============================================================
-- 127_ai_agent_task_guardrails.sql
-- Phase 14: budgets, scoped limits and kill-switch enforcement.
--
-- Extends the existing runtime budget and task/outbound choke points instead
-- of introducing a parallel execution path.
-- ============================================================

alter table public.ai_runtime_policies
  add column if not exists daily_message_budget bigint,
  add column if not exists daily_estimated_provider_cost_micros bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.ai_runtime_policies'::regclass
      and conname='ai_runtime_policies_daily_message_budget_check'
  ) then
    alter table public.ai_runtime_policies
      add constraint ai_runtime_policies_daily_message_budget_check
      check (daily_message_budget is null or daily_message_budget >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid='public.ai_runtime_policies'::regclass
      and conname='ai_runtime_policies_daily_provider_cost_check'
  ) then
    alter table public.ai_runtime_policies
      add constraint ai_runtime_policies_daily_provider_cost_check
      check (
        daily_estimated_provider_cost_micros is null
        or daily_estimated_provider_cost_micros >= 0
      );
  end if;
end
$$;

alter table public.ai_agent_budget_policies
  add column if not exists max_messages bigint,
  add column if not exists max_estimated_provider_cost_micros bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.ai_agent_budget_policies'::regclass
      and conname='ai_agent_budget_policies_max_messages_check'
  ) then
    alter table public.ai_agent_budget_policies
      add constraint ai_agent_budget_policies_max_messages_check
      check (max_messages is null or max_messages >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid='public.ai_agent_budget_policies'::regclass
      and conname='ai_agent_budget_policies_max_provider_cost_check'
  ) then
    alter table public.ai_agent_budget_policies
      add constraint ai_agent_budget_policies_max_provider_cost_check
      check (
        max_estimated_provider_cost_micros is null
        or max_estimated_provider_cost_micros >= 0
      );
  end if;
end
$$;

alter table public.ai_runtime_budget_reservations
  add column if not exists task_id uuid
    references public.ai_agent_tasks(id) on delete cascade,
  add column if not exists channel text,
  add column if not exists estimated_provider_cost_micros bigint not null default 0;

create index if not exists ai_runtime_budget_reservations_task_idx
  on public.ai_runtime_budget_reservations(task_id, expires_at)
  where task_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.ai_runtime_budget_reservations'::regclass
      and conname='ai_runtime_budget_reservations_provider_cost_check'
  ) then
    alter table public.ai_runtime_budget_reservations
      add constraint ai_runtime_budget_reservations_provider_cost_check
      check (estimated_provider_cost_micros >= 0);
  end if;
end
$$;

alter table public.ai_agent_runs
  add column if not exists estimated_provider_cost_micros bigint not null default 0,
  add column if not exists provider_cost_micros bigint,
  add column if not exists provider_cost_rate_snapshot jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.ai_agent_runs'::regclass
      and conname='ai_agent_runs_estimated_provider_cost_check'
  ) then
    alter table public.ai_agent_runs
      add constraint ai_agent_runs_estimated_provider_cost_check
      check (estimated_provider_cost_micros >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid='public.ai_agent_runs'::regclass
      and conname='ai_agent_runs_provider_cost_check'
  ) then
    alter table public.ai_agent_runs
      add constraint ai_agent_runs_provider_cost_check
      check (provider_cost_micros is null or provider_cost_micros >= 0);
  end if;
end
$$;

create table public.ai_provider_model_cost_rates (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  provider_connection_id uuid not null
    references public.ai_provider_connections(id) on delete cascade,
  model text not null check (length(btrim(model)) > 0),
  input_micros_per_million_tokens bigint not null
    check (input_micros_per_million_tokens >= 0),
  output_micros_per_million_tokens bigint not null
    check (output_micros_per_million_tokens >= 0),
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, provider_connection_id, model)
);

create index ai_provider_model_cost_rates_lookup_idx
  on public.ai_provider_model_cost_rates(
    account_id, provider_connection_id, model, is_active
  );

alter table public.ai_provider_model_cost_rates enable row level security;

create policy ai_provider_model_cost_rates_select
  on public.ai_provider_model_cost_rates
  for select
  using (is_account_member(account_id, 'admin'));

create policy ai_provider_model_cost_rates_insert
  on public.ai_provider_model_cost_rates
  for insert
  with check (is_account_member(account_id, 'admin'));

create policy ai_provider_model_cost_rates_update
  on public.ai_provider_model_cost_rates
  for update
  using (is_account_member(account_id, 'admin'))
  with check (is_account_member(account_id, 'admin'));

create policy ai_provider_model_cost_rates_delete
  on public.ai_provider_model_cost_rates
  for delete
  using (is_account_member(account_id, 'admin'));

revoke all on table public.ai_provider_model_cost_rates
  from anon, authenticated;
grant select, insert, update, delete
  on table public.ai_provider_model_cost_rates to authenticated;
grant all on table public.ai_provider_model_cost_rates to service_role;

create or replace function public.update_ai_provider_model_cost_rates_updated_at()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  new.updated_at=now();
  return new;
end;
$$;

create trigger ai_provider_model_cost_rates_updated_at
  before update on public.ai_provider_model_cost_rates
  for each row execute function public.update_ai_provider_model_cost_rates_updated_at();

create table public.ai_agent_scope_controls (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  scope_type text not null check (scope_type in ('task_type','channel')),
  scope_key text not null check (length(btrim(scope_key)) > 0),
  is_enabled boolean not null default true,
  daily_run_limit integer check (daily_run_limit is null or daily_run_limit >= 0),
  daily_target_limit integer check (daily_target_limit is null or daily_target_limit >= 0),
  daily_message_limit integer check (daily_message_limit is null or daily_message_limit >= 0),
  daily_estimated_provider_cost_micros bigint
    check (
      daily_estimated_provider_cost_micros is null
      or daily_estimated_provider_cost_micros >= 0
    ),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, scope_type, scope_key)
);

create index ai_agent_scope_controls_lookup_idx
  on public.ai_agent_scope_controls(account_id, scope_type, scope_key);

alter table public.ai_agent_scope_controls enable row level security;

create policy ai_agent_scope_controls_select
  on public.ai_agent_scope_controls
  for select
  using (is_account_member(account_id, 'admin'));

create policy ai_agent_scope_controls_insert
  on public.ai_agent_scope_controls
  for insert
  with check (is_account_member(account_id, 'admin'));

create policy ai_agent_scope_controls_update
  on public.ai_agent_scope_controls
  for update
  using (is_account_member(account_id, 'admin'))
  with check (is_account_member(account_id, 'admin'));

create policy ai_agent_scope_controls_delete
  on public.ai_agent_scope_controls
  for delete
  using (is_account_member(account_id, 'admin'));

revoke all on table public.ai_agent_scope_controls from anon, authenticated;
grant select, insert, update, delete
  on table public.ai_agent_scope_controls to authenticated;
grant all on table public.ai_agent_scope_controls to service_role;

create or replace function public.update_ai_agent_scope_controls_updated_at()
returns trigger
language plpgsql
set search_path=public
as $$
begin
  new.updated_at=now();
  return new;
end;
$$;

create trigger ai_agent_scope_controls_updated_at
  before update on public.ai_agent_scope_controls
  for each row execute function public.update_ai_agent_scope_controls_updated_at();

create or replace function public.apply_ai_agent_run_provider_cost()
returns trigger
language plpgsql
set search_path=public
as $$
declare
  v_input_rate numeric;
  v_output_rate numeric;
begin
  if jsonb_typeof(new.provider_cost_rate_snapshot)='object'
     and new.provider_cost_rate_snapshot ? 'input_micros_per_million_tokens'
     and new.provider_cost_rate_snapshot ? 'output_micros_per_million_tokens'
     and new.input_tokens is not null
     and new.output_tokens is not null then
    v_input_rate :=
      (new.provider_cost_rate_snapshot ->> 'input_micros_per_million_tokens')::numeric;
    v_output_rate :=
      (new.provider_cost_rate_snapshot ->> 'output_micros_per_million_tokens')::numeric;

    new.provider_cost_micros := ceiling(
      greatest(new.input_tokens,0)::numeric * v_input_rate / 1000000
      +
      greatest(new.output_tokens,0)::numeric * v_output_rate / 1000000
    )::bigint;
  end if;

  return new;
end;
$$;

drop trigger if exists ai_agent_runs_provider_cost
  on public.ai_agent_runs;
create trigger ai_agent_runs_provider_cost
  before insert or update of input_tokens, output_tokens, provider_cost_rate_snapshot
  on public.ai_agent_runs
  for each row execute function public.apply_ai_agent_run_provider_cost();

create or replace function public.reserve_ai_agent_runtime_budget(
  p_account_id uuid,
  p_run_id uuid,
  p_estimated_input_tokens integer,
  p_estimated_output_tokens integer
) returns text
language plpgsql
security definer
set search_path=public
as $$
declare
  v_policy public.ai_runtime_policies%rowtype;
  v_policy_found boolean := false;
  v_run public.ai_agent_runs%rowtype;
  v_task public.ai_agent_tasks%rowtype;
  v_agent_status text;
  v_model text;
  v_minute_runs bigint;
  v_input bigint;
  v_output bigint;
  v_cost bigint;
  v_reserved_input bigint;
  v_reserved_output bigint;
  v_reserved_cost bigint;
  v_budget record;
  v_rate_limit record;
  v_scope record;
  v_start timestamptz;
  v_runs bigint;
  v_agent_input bigint;
  v_agent_output bigint;
  v_agent_cost bigint;
  v_agent_reserved_input bigint;
  v_agent_reserved_output bigint;
  v_agent_reserved_cost bigint;
  v_task_input bigint;
  v_task_output bigint;
  v_task_cost bigint;
  v_task_reserved_input bigint;
  v_task_reserved_output bigint;
  v_task_reserved_cost bigint;
  v_task_token_budget bigint;
  v_task_cost_budget bigint;
  v_input_rate bigint;
  v_output_rate bigint;
  v_estimated_cost bigint := 0;
  v_cost_rate_found boolean := false;
  v_cost_limit_required boolean := false;
  v_scope_key text;
  v_scope_runs bigint;
  v_scope_cost bigint;
  v_scope_reserved_cost bigint;
  v_window_start timestamptz;
  v_window_runs bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text,6501));

  select * into v_run
  from public.ai_agent_runs
  where id=p_run_id and account_id=p_account_id
  for update;

  if v_run.id is null then return 'RUN_NOT_FOUND'; end if;

  select status into v_agent_status
  from public.ai_agents
  where account_id=p_account_id
    and id=v_run.ai_agent_id;

  if v_agent_status is null then return 'AGENT_NOT_FOUND'; end if;
  if v_agent_status<>'active' then return 'AGENT_PAUSED'; end if;

  select model into v_model
  from public.ai_agent_revisions
  where account_id=p_account_id
    and id=v_run.agent_revision_id
    and agent_id=v_run.ai_agent_id;

  if v_model is null then return 'REVISION_NOT_FOUND'; end if;

  if v_run.task_id is not null then
    select * into v_task
    from public.ai_agent_tasks
    where account_id=p_account_id
      and id=v_run.task_id;

    if v_task.id is null then return 'TASK_NOT_FOUND'; end if;
    if v_task.status<>'running' then return 'TASK_NOT_RUNNING'; end if;
  end if;

  select * into v_policy
  from public.ai_runtime_policies
  where account_id=p_account_id;
  v_policy_found:=found;

  if v_policy_found then
    if v_policy.kill_switch then return 'AI_KILL_SWITCH'; end if;
    if not v_policy.multi_agent_enabled then return 'MULTI_AGENT_DISABLED'; end if;

    select count(*) into v_minute_runs
    from public.ai_agent_runs
    where account_id=p_account_id
      and created_at>=now()-interval '1 minute';

    if v_minute_runs>v_policy.max_runs_per_minute then
      return 'RATE_LIMIT_EXCEEDED';
    end if;
  end if;

  for v_rate_limit in
    select distinct on (rate_window)
      rate_window,max_requests,agent_id
    from public.ai_agent_rate_limit_overrides
    where account_id=p_account_id
      and is_active=true
      and (agent_id=v_run.ai_agent_id or agent_id is null)
    order by rate_window,(agent_id is not null) desc,updated_at desc
  loop
    v_window_start := case v_rate_limit.rate_window
      when 'month' then date_trunc('month',now())
      when 'day' then date_trunc('day',now())
      else now()-interval '1 minute'
    end;

    select count(*) into v_window_runs
    from public.ai_agent_runs
    where account_id=p_account_id
      and created_at>=v_window_start
      and (
        v_rate_limit.agent_id is null
        or ai_agent_id=v_run.ai_agent_id
      );

    if v_window_runs>v_rate_limit.max_requests then
      return 'AGENT_RATE_LIMIT_EXCEEDED:'||v_rate_limit.rate_window;
    end if;
  end loop;

  if v_task.id is not null then
    v_scope_key:=v_task.task_type||'@'||v_task.task_type_version::text;

    select * into v_scope
    from public.ai_agent_scope_controls
    where account_id=p_account_id
      and scope_type='task_type'
      and scope_key=v_scope_key;

    if found then
      if not v_scope.is_enabled then return 'TASK_TYPE_DISABLED'; end if;
      if v_scope.daily_run_limit is not null then
        select count(*) into v_scope_runs
        from public.ai_agent_runs as run
        join public.ai_agent_tasks as task
          on task.account_id=run.account_id and task.id=run.task_id
        where run.account_id=p_account_id
          and task.task_type=v_task.task_type
          and task.task_type_version=v_task.task_type_version
          and run.created_at>=date_trunc('day',now());
        if v_scope_runs>v_scope.daily_run_limit then
          return 'TASK_TYPE_DAILY_RUN_LIMIT_EXCEEDED';
        end if;
      end if;
      if v_scope.daily_estimated_provider_cost_micros is not null then
        v_cost_limit_required:=true;
      end if;
    end if;

    select * into v_scope
    from public.ai_agent_scope_controls
    where account_id=p_account_id
      and scope_type='channel'
      and scope_key=v_task.channel;

    if found then
      if not v_scope.is_enabled then return 'CHANNEL_DISABLED'; end if;
      if v_scope.daily_run_limit is not null then
        select count(*) into v_scope_runs
        from public.ai_agent_runs as run
        join public.ai_agent_tasks as task
          on task.account_id=run.account_id and task.id=run.task_id
        where run.account_id=p_account_id
          and task.channel=v_task.channel
          and run.created_at>=date_trunc('day',now());
        if v_scope_runs>v_scope.daily_run_limit then
          return 'CHANNEL_DAILY_RUN_LIMIT_EXCEEDED';
        end if;
      end if;
      if v_scope.daily_estimated_provider_cost_micros is not null then
        v_cost_limit_required:=true;
      end if;
    end if;
  end if;

  select
    input_micros_per_million_tokens,
    output_micros_per_million_tokens
  into v_input_rate,v_output_rate
  from public.ai_provider_model_cost_rates
  where account_id=p_account_id
    and provider_connection_id=v_run.provider_connection_id
    and model=v_model
    and is_active=true
  order by updated_at desc
  limit 1;

  if found then
    v_cost_rate_found:=true;
    v_estimated_cost:=ceiling(
      greatest(p_estimated_input_tokens,0)::numeric
        * v_input_rate::numeric / 1000000
      +
      greatest(p_estimated_output_tokens,0)::numeric
        * v_output_rate::numeric / 1000000
    )::bigint;
  end if;

  if v_policy_found
     and v_policy.daily_estimated_provider_cost_micros is not null then
    v_cost_limit_required:=true;
  end if;

  if v_task.id is not null
     and jsonb_typeof(v_task.budget_policy->'dailyEstimatedProviderCostMicros')='number' then
    v_task_cost_budget:=
      (v_task.budget_policy->>'dailyEstimatedProviderCostMicros')::bigint;
    if v_task_cost_budget<0 then return 'TASK_PROVIDER_COST_BUDGET_INVALID'; end if;
    v_cost_limit_required:=true;
  else
    v_task_cost_budget:=null;
  end if;

  if v_task.id is not null
     and jsonb_typeof(v_task.budget_policy->'dailyTokenBudget')='number' then
    v_task_token_budget:=(v_task.budget_policy->>'dailyTokenBudget')::bigint;
    if v_task_token_budget<0 then return 'TASK_TOKEN_BUDGET_INVALID'; end if;
  else
    v_task_token_budget:=null;
  end if;

  if exists (
    select 1 from public.ai_agent_budget_policies
    where account_id=p_account_id
      and is_active=true
      and (agent_id=v_run.ai_agent_id or agent_id is null)
      and max_estimated_provider_cost_micros is not null
  ) then
    v_cost_limit_required:=true;
  end if;

  if v_cost_limit_required and not v_cost_rate_found then
    return 'PROVIDER_COST_RATE_REQUIRED';
  end if;

  select
    coalesce(sum(input_tokens),0),
    coalesce(sum(output_tokens),0),
    coalesce(sum(coalesce(provider_cost_micros,estimated_provider_cost_micros,0)),0)
  into v_input,v_output,v_cost
  from public.ai_agent_runs
  where account_id=p_account_id
    and created_at>=date_trunc('day',now())
    and status in ('succeeded','failed')
    and id<>p_run_id;

  select
    coalesce(sum(estimated_input_tokens),0),
    coalesce(sum(estimated_output_tokens),0),
    coalesce(sum(estimated_provider_cost_micros),0)
  into v_reserved_input,v_reserved_output,v_reserved_cost
  from public.ai_runtime_budget_reservations
  where account_id=p_account_id
    and expires_at>now()
    and run_id<>p_run_id;

  if v_policy_found then
    if v_policy.daily_input_token_budget is not null
       and v_input+v_reserved_input+greatest(p_estimated_input_tokens,0)
         >v_policy.daily_input_token_budget then
      return 'DAILY_INPUT_BUDGET_EXCEEDED';
    end if;
    if v_policy.daily_output_token_budget is not null
       and v_output+v_reserved_output+greatest(p_estimated_output_tokens,0)
         >v_policy.daily_output_token_budget then
      return 'DAILY_OUTPUT_BUDGET_EXCEEDED';
    end if;
    if v_policy.daily_estimated_provider_cost_micros is not null
       and v_cost+v_reserved_cost+v_estimated_cost
         >v_policy.daily_estimated_provider_cost_micros then
      return 'DAILY_PROVIDER_COST_BUDGET_EXCEEDED';
    end if;
  end if;

  for v_budget in
    select distinct on (period)
      period,max_runs,max_input_tokens,max_output_tokens,
      max_estimated_provider_cost_micros,hard_action,agent_id
    from public.ai_agent_budget_policies
    where account_id=p_account_id
      and is_active=true
      and (agent_id=v_run.ai_agent_id or agent_id is null)
    order by period,(agent_id is not null) desc,updated_at desc
  loop
    v_start:=case v_budget.period
      when 'monthly' then date_trunc('month',now())
      else date_trunc('day',now())
    end;

    select
      count(*),
      coalesce(sum(input_tokens),0),
      coalesce(sum(output_tokens),0),
      coalesce(sum(coalesce(provider_cost_micros,estimated_provider_cost_micros,0)),0)
    into v_runs,v_agent_input,v_agent_output,v_agent_cost
    from public.ai_agent_runs
    where account_id=p_account_id
      and created_at>=v_start
      and (v_budget.agent_id is null or ai_agent_id=v_run.ai_agent_id)
      and id<>p_run_id;

    select
      coalesce(sum(res.estimated_input_tokens),0),
      coalesce(sum(res.estimated_output_tokens),0),
      coalesce(sum(res.estimated_provider_cost_micros),0)
    into v_agent_reserved_input,v_agent_reserved_output,v_agent_reserved_cost
    from public.ai_runtime_budget_reservations as res
    join public.ai_agent_runs as reserved_run
      on reserved_run.id=res.run_id
     and reserved_run.account_id=res.account_id
    where res.account_id=p_account_id
      and res.expires_at>now()
      and res.run_id<>p_run_id
      and reserved_run.created_at>=v_start
      and (
        v_budget.agent_id is null
        or reserved_run.ai_agent_id=v_run.ai_agent_id
      );

    if v_runs+1>v_budget.max_runs then
      return 'AGENT_BUDGET_RUNS_EXCEEDED:'||v_budget.hard_action;
    end if;
    if v_agent_input+v_agent_reserved_input+greatest(p_estimated_input_tokens,0)
       >v_budget.max_input_tokens then
      return 'AGENT_BUDGET_INPUT_EXCEEDED:'||v_budget.hard_action;
    end if;
    if v_agent_output+v_agent_reserved_output+greatest(p_estimated_output_tokens,0)
       >v_budget.max_output_tokens then
      return 'AGENT_BUDGET_OUTPUT_EXCEEDED:'||v_budget.hard_action;
    end if;
    if v_budget.max_estimated_provider_cost_micros is not null
       and v_agent_cost+v_agent_reserved_cost+v_estimated_cost
         >v_budget.max_estimated_provider_cost_micros then
      return 'AGENT_BUDGET_PROVIDER_COST_EXCEEDED:'||v_budget.hard_action;
    end if;
  end loop;

  if v_task.id is not null then
    select
      coalesce(sum(input_tokens),0),
      coalesce(sum(output_tokens),0),
      coalesce(sum(coalesce(provider_cost_micros,estimated_provider_cost_micros,0)),0)
    into v_task_input,v_task_output,v_task_cost
    from public.ai_agent_runs
    where account_id=p_account_id
      and task_id=v_task.id
      and created_at>=date_trunc('day',now())
      and status in ('succeeded','failed')
      and id<>p_run_id;

    select
      coalesce(sum(res.estimated_input_tokens),0),
      coalesce(sum(res.estimated_output_tokens),0),
      coalesce(sum(res.estimated_provider_cost_micros),0)
    into v_task_reserved_input,v_task_reserved_output,v_task_reserved_cost
    from public.ai_runtime_budget_reservations as res
    where res.account_id=p_account_id
      and res.task_id=v_task.id
      and res.expires_at>now()
      and res.run_id<>p_run_id;

    if v_task_token_budget is not null
       and v_task_input+v_task_output
         +v_task_reserved_input+v_task_reserved_output
         +greatest(p_estimated_input_tokens,0)
         +greatest(p_estimated_output_tokens,0)
         >v_task_token_budget then
      return 'TASK_TOKEN_BUDGET_EXCEEDED';
    end if;

    if v_task_cost_budget is not null
       and v_task_cost+v_task_reserved_cost+v_estimated_cost
         >v_task_cost_budget then
      return 'TASK_PROVIDER_COST_BUDGET_EXCEEDED';
    end if;

    for v_scope in
      select * from public.ai_agent_scope_controls
      where account_id=p_account_id
        and (
          (scope_type='task_type'
           and scope_key=v_task.task_type||'@'||v_task.task_type_version::text)
          or
          (scope_type='channel' and scope_key=v_task.channel)
        )
        and daily_estimated_provider_cost_micros is not null
    loop
      if v_scope.scope_type='task_type' then
        select
          coalesce(sum(coalesce(run.provider_cost_micros,run.estimated_provider_cost_micros,0)),0)
        into v_scope_cost
        from public.ai_agent_runs as run
        join public.ai_agent_tasks as task
          on task.account_id=run.account_id and task.id=run.task_id
        where run.account_id=p_account_id
          and task.task_type=v_task.task_type
          and task.task_type_version=v_task.task_type_version
          and run.created_at>=date_trunc('day',now())
          and run.id<>p_run_id;

        select coalesce(sum(res.estimated_provider_cost_micros),0)
        into v_scope_reserved_cost
        from public.ai_runtime_budget_reservations as res
        join public.ai_agent_runs as run
          on run.id=res.run_id and run.account_id=res.account_id
        join public.ai_agent_tasks as task
          on task.id=run.task_id and task.account_id=run.account_id
        where res.account_id=p_account_id
          and res.expires_at>now()
          and res.run_id<>p_run_id
          and task.task_type=v_task.task_type
          and task.task_type_version=v_task.task_type_version;
      else
        select
          coalesce(sum(coalesce(run.provider_cost_micros,run.estimated_provider_cost_micros,0)),0)
        into v_scope_cost
        from public.ai_agent_runs as run
        join public.ai_agent_tasks as task
          on task.account_id=run.account_id and task.id=run.task_id
        where run.account_id=p_account_id
          and task.channel=v_task.channel
          and run.created_at>=date_trunc('day',now())
          and run.id<>p_run_id;

        select coalesce(sum(res.estimated_provider_cost_micros),0)
        into v_scope_reserved_cost
        from public.ai_runtime_budget_reservations as res
        join public.ai_agent_runs as run
          on run.id=res.run_id and run.account_id=res.account_id
        join public.ai_agent_tasks as task
          on task.id=run.task_id and task.account_id=run.account_id
        where res.account_id=p_account_id
          and res.expires_at>now()
          and res.run_id<>p_run_id
          and task.channel=v_task.channel;
      end if;

      if v_scope_cost+v_scope_reserved_cost+v_estimated_cost
         >v_scope.daily_estimated_provider_cost_micros then
        return upper(v_scope.scope_type)||'_PROVIDER_COST_BUDGET_EXCEEDED';
      end if;
    end loop;
  end if;

  update public.ai_agent_runs
  set estimated_provider_cost_micros=v_estimated_cost,
      provider_cost_rate_snapshot=
        case when v_cost_rate_found then
          jsonb_build_object(
            'provider_connection_id',v_run.provider_connection_id,
            'model',v_model,
            'input_micros_per_million_tokens',v_input_rate,
            'output_micros_per_million_tokens',v_output_rate,
            'reserved_at',now()
          )
        else '{}'::jsonb end
  where id=p_run_id;

  insert into public.ai_runtime_budget_reservations(
    run_id,account_id,task_id,channel,
    estimated_input_tokens,estimated_output_tokens,
    estimated_provider_cost_micros,expires_at
  ) values (
    p_run_id,p_account_id,v_run.task_id,
    case when v_task.id is null then null else v_task.channel end,
    greatest(p_estimated_input_tokens,0),
    greatest(p_estimated_output_tokens,0),
    v_estimated_cost,
    now()+interval '15 minutes'
  )
  on conflict (run_id) do update set
    task_id=excluded.task_id,
    channel=excluded.channel,
    estimated_input_tokens=excluded.estimated_input_tokens,
    estimated_output_tokens=excluded.estimated_output_tokens,
    estimated_provider_cost_micros=excluded.estimated_provider_cost_micros,
    expires_at=excluded.expires_at;

  return null;
end;
$$;

revoke all on function public.reserve_ai_agent_runtime_budget(
  uuid,uuid,integer,integer
) from public,anon,authenticated;
grant execute on function public.reserve_ai_agent_runtime_budget(
  uuid,uuid,integer,integer
) to service_role;

create or replace function public.enforce_ai_agent_task_target_scope_guard()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_task public.ai_agent_tasks%rowtype;
  v_control public.ai_agent_scope_controls%rowtype;
  v_count bigint;
begin
  select * into v_task
  from public.ai_agent_tasks
  where account_id=new.account_id and id=new.task_id;

  if v_task.id is null then
    raise exception 'AGENT_TASK_NOT_FOUND';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(new.account_id::text||':target-guard',6511)
  );

  select * into v_control
  from public.ai_agent_scope_controls
  where account_id=new.account_id
    and scope_type='task_type'
    and scope_key=v_task.task_type||'@'||v_task.task_type_version::text;

  if found then
    if not v_control.is_enabled then
      raise exception 'AGENT_TASK_TYPE_DISABLED';
    end if;
    if v_control.daily_target_limit is not null then
      select count(*) into v_count
      from public.ai_agent_task_targets as target
      join public.ai_agent_tasks as task
        on task.account_id=target.account_id and task.id=target.task_id
      where target.account_id=new.account_id
        and task.task_type=v_task.task_type
        and task.task_type_version=v_task.task_type_version
        and target.created_at>=date_trunc('day',now());
      if v_count>=v_control.daily_target_limit then
        raise exception 'AGENT_TASK_TYPE_DAILY_TARGET_LIMIT_EXCEEDED';
      end if;
    end if;
  end if;

  select * into v_control
  from public.ai_agent_scope_controls
  where account_id=new.account_id
    and scope_type='channel'
    and scope_key=v_task.channel;

  if found then
    if not v_control.is_enabled then
      raise exception 'AGENT_CHANNEL_DISABLED';
    end if;
    if v_control.daily_target_limit is not null then
      select count(*) into v_count
      from public.ai_agent_task_targets as target
      join public.ai_agent_tasks as task
        on task.account_id=target.account_id and task.id=target.task_id
      where target.account_id=new.account_id
        and task.channel=v_task.channel
        and target.created_at>=date_trunc('day',now());
      if v_count>=v_control.daily_target_limit then
        raise exception 'AGENT_CHANNEL_DAILY_TARGET_LIMIT_EXCEEDED';
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_ai_agent_task_target_scope_guard()
  from public,anon,authenticated;

drop trigger if exists ai_agent_task_targets_scope_guard
  on public.ai_agent_task_targets;
create trigger ai_agent_task_targets_scope_guard
  before insert on public.ai_agent_task_targets
  for each row execute function public.enforce_ai_agent_task_target_scope_guard();

create or replace function public.enforce_ai_agent_outbound_message_budget()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_task public.ai_agent_tasks%rowtype;
  v_policy public.ai_runtime_policies%rowtype;
  v_control public.ai_agent_scope_controls%rowtype;
  v_budget record;
  v_count bigint;
  v_start timestamptz;
  v_task_message_budget bigint;
begin
  select * into v_task
  from public.ai_agent_tasks
  where account_id=new.account_id and id=new.task_id;

  if v_task.id is null then
    raise exception 'AGENT_TASK_NOT_FOUND';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(new.account_id::text||':message-guard',6512)
  );

  select * into v_policy
  from public.ai_runtime_policies
  where account_id=new.account_id;

  if found then
    if v_policy.kill_switch then raise exception 'AI_KILL_SWITCH'; end if;
    if not v_policy.outbound_task_delivery_enabled then
      raise exception 'OUTBOUND_TASK_DELIVERY_DISABLED';
    end if;
    if v_policy.daily_message_budget is not null then
      select count(*) into v_count
      from public.ai_agent_task_outbound_messages
      where account_id=new.account_id
        and created_at>=date_trunc('day',now())
        and status<>'cancelled';
      if v_count>=v_policy.daily_message_budget then
        raise exception 'ACCOUNT_DAILY_MESSAGE_BUDGET_EXCEEDED';
      end if;
    end if;
  end if;

  if exists (
    select 1 from public.ai_agents
    where account_id=new.account_id
      and id=v_task.agent_id
      and status<>'active'
  ) then
    raise exception 'AGENT_PAUSED';
  end if;

  if v_task.status<>'running' then
    raise exception 'TASK_NOT_RUNNING';
  end if;

  if jsonb_typeof(v_task.budget_policy->'dailyMessageBudget')='number' then
    v_task_message_budget:=
      (v_task.budget_policy->>'dailyMessageBudget')::bigint;
    if v_task_message_budget<0 then
      raise exception 'TASK_MESSAGE_BUDGET_INVALID';
    end if;

    select count(*) into v_count
    from public.ai_agent_task_outbound_messages
    where account_id=new.account_id
      and task_id=v_task.id
      and created_at>=date_trunc('day',now())
      and status<>'cancelled';

    if v_count>=v_task_message_budget then
      raise exception 'TASK_DAILY_MESSAGE_BUDGET_EXCEEDED';
    end if;
  end if;

  for v_budget in
    select distinct on (period)
      period,max_messages,hard_action,agent_id
    from public.ai_agent_budget_policies
    where account_id=new.account_id
      and is_active=true
      and max_messages is not null
      and (agent_id=v_task.agent_id or agent_id is null)
    order by period,(agent_id is not null) desc,updated_at desc
  loop
    v_start:=case v_budget.period
      when 'monthly' then date_trunc('month',now())
      else date_trunc('day',now())
    end;

    select count(*) into v_count
    from public.ai_agent_task_outbound_messages as outbound
    join public.ai_agent_tasks as task
      on task.account_id=outbound.account_id and task.id=outbound.task_id
    where outbound.account_id=new.account_id
      and outbound.created_at>=v_start
      and outbound.status<>'cancelled'
      and (
        v_budget.agent_id is null
        or task.agent_id=v_task.agent_id
      );

    if v_count>=v_budget.max_messages then
      raise exception 'AGENT_BUDGET_MESSAGES_EXCEEDED:%',
        v_budget.hard_action;
    end if;
  end loop;

  select * into v_control
  from public.ai_agent_scope_controls
  where account_id=new.account_id
    and scope_type='task_type'
    and scope_key=v_task.task_type||'@'||v_task.task_type_version::text;

  if found then
    if not v_control.is_enabled then raise exception 'AGENT_TASK_TYPE_DISABLED'; end if;
    if v_control.daily_message_limit is not null then
      select count(*) into v_count
      from public.ai_agent_task_outbound_messages as outbound
      join public.ai_agent_tasks as task
        on task.account_id=outbound.account_id and task.id=outbound.task_id
      where outbound.account_id=new.account_id
        and task.task_type=v_task.task_type
        and task.task_type_version=v_task.task_type_version
        and outbound.created_at>=date_trunc('day',now())
        and outbound.status<>'cancelled';
      if v_count>=v_control.daily_message_limit then
        raise exception 'TASK_TYPE_DAILY_MESSAGE_LIMIT_EXCEEDED';
      end if;
    end if;
  end if;

  select * into v_control
  from public.ai_agent_scope_controls
  where account_id=new.account_id
    and scope_type='channel'
    and scope_key=v_task.channel;

  if found then
    if not v_control.is_enabled then raise exception 'AGENT_CHANNEL_DISABLED'; end if;
    if v_control.daily_message_limit is not null then
      select count(*) into v_count
      from public.ai_agent_task_outbound_messages as outbound
      join public.ai_agent_tasks as task
        on task.account_id=outbound.account_id and task.id=outbound.task_id
      where outbound.account_id=new.account_id
        and task.channel=v_task.channel
        and outbound.created_at>=date_trunc('day',now())
        and outbound.status<>'cancelled';
      if v_count>=v_control.daily_message_limit then
        raise exception 'CHANNEL_DAILY_MESSAGE_LIMIT_EXCEEDED';
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_ai_agent_outbound_message_budget()
  from public,anon,authenticated;

drop trigger if exists ai_agent_task_outbound_message_budget_guard
  on public.ai_agent_task_outbound_messages;
create trigger ai_agent_task_outbound_message_budget_guard
  before insert on public.ai_agent_task_outbound_messages
  for each row execute function public.enforce_ai_agent_outbound_message_budget();
