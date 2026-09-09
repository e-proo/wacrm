-- ============================================================
-- 056_operational_hardening.sql — operational observability
--
-- Uses the existing append-only ai_usage_log from migration 033
-- instead of duplicating token accounting. Adds only the missing
-- operational records: tool attempts, rate-limit overrides, and
-- reconciliation job leases.
-- ============================================================

create table if not exists public.ai_agent_tool_call_attempts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  run_id uuid references public.ai_agent_runs(id) on delete set null,
  agent_id uuid references public.ai_agents(id) on delete set null,
  revision_id uuid references public.ai_agent_revisions(id) on delete set null,
  tool_key text not null,
  tool_version integer not null default 1,
  round integer not null default 1 check (round > 0),
  permission text not null check (permission in ('read', 'propose', 'execute')),
  status text not null check (status in ('accepted', 'denied', 'succeeded', 'failed')),
  error_code text,
  input_hash text,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default now()
);

create index if not exists ai_agent_tool_attempts_account_idx
  on public.ai_agent_tool_call_attempts(account_id, created_at desc);
create index if not exists ai_agent_tool_attempts_tool_idx
  on public.ai_agent_tool_call_attempts(account_id, tool_key, created_at desc);

alter table public.ai_agent_tool_call_attempts enable row level security;
drop policy if exists ai_agent_tool_attempts_select on public.ai_agent_tool_call_attempts;
create policy ai_agent_tool_attempts_select on public.ai_agent_tool_call_attempts for select
  using (is_account_member(account_id, 'admin'));

create table if not exists public.ai_agent_rate_limit_overrides (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  agent_id uuid references public.ai_agents(id) on delete cascade,
  -- `window` is reserved by PostgreSQL window-function syntax;
  -- use an explicit name to keep the migration valid.
  rate_window text not null check (rate_window in ('minute', 'day', 'month')),
  max_requests integer not null check (max_requests > 0),
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(account_id, agent_id, rate_window)
);

alter table public.ai_agent_rate_limit_overrides enable row level security;
drop policy if exists ai_agent_rate_limits_select on public.ai_agent_rate_limit_overrides;
create policy ai_agent_rate_limits_select on public.ai_agent_rate_limit_overrides for select
  using (is_account_member(account_id, 'admin'));
drop policy if exists ai_agent_rate_limits_insert on public.ai_agent_rate_limit_overrides;
create policy ai_agent_rate_limits_insert on public.ai_agent_rate_limit_overrides for insert
  with check (is_account_member(account_id, 'admin'));
drop policy if exists ai_agent_rate_limits_update on public.ai_agent_rate_limit_overrides;
create policy ai_agent_rate_limits_update on public.ai_agent_rate_limit_overrides for update
  using (is_account_member(account_id, 'admin'));

create table if not exists public.ai_reconciliation_jobs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.accounts(id) on delete cascade,
  job_key text not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  claimed_by text,
  last_error_code text,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(account_id, job_key)
);

create index if not exists ai_reconciliation_jobs_due_idx
  on public.ai_reconciliation_jobs(status, available_at)
  where status in ('queued', 'running');

alter table public.ai_reconciliation_jobs enable row level security;
drop policy if exists ai_reconciliation_jobs_select on public.ai_reconciliation_jobs;
create policy ai_reconciliation_jobs_select on public.ai_reconciliation_jobs for select
  using (account_id is null or is_account_member(account_id, 'admin'));

create or replace function public.update_ai_agent_rate_limits_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists ai_agent_rate_limits_updated_at on public.ai_agent_rate_limit_overrides;
create trigger ai_agent_rate_limits_updated_at
  before update on public.ai_agent_rate_limit_overrides
  for each row execute function public.update_ai_agent_rate_limits_updated_at();

create or replace function public.update_ai_reconciliation_jobs_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists ai_reconciliation_jobs_updated_at on public.ai_reconciliation_jobs;
create trigger ai_reconciliation_jobs_updated_at
  before update on public.ai_reconciliation_jobs
  for each row execute function public.update_ai_reconciliation_jobs_updated_at();
