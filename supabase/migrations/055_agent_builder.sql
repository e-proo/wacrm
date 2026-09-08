-- ============================================================
-- 055_agent_builder.sql — Agent builder foundations (Phase 4)
--
-- Phase 4's builder lets an authorized user compose a new AI
-- agent from TRUSTED, REGISTERED components (templates + tool
-- catalog + route conditions). No arbitrary code, SQL, or URLs.
--
-- New tables:
--   ai_agent_templates      — versioned starting points. System
--                             templates are seeded by this
--                             migration; account-owned templates
--                             are cloned from a system template or
--                             saved from an existing agent.
--   ai_agent_test_cases     — per-agent test fixtures + assertions
--                             the publish check can run.
--   ai_agent_evaluation_runs— results of running the test suite
--                             against a draft revision (no sends,
--                             no side effects).
--   ai_agent_budget_policies— per-account (or per-agent) token /
--                             cost / run caps with soft + hard
--                             thresholds.
--
-- The builder itself is UI + API on top of the Phase 1 tables
-- (ai_agents / ai_agent_revisions / ai_agent_routes / grants);
-- nothing there changes shape.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1) ai_agent_templates
-- ------------------------------------------------------------
create table if not exists public.ai_agent_templates (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid references accounts(id) on delete cascade,
  -- NULL account_id = SYSTEM template (visible to every account,
  -- read-only). Non-null = account-owned clone.
  -- System templates are referenced by `system_template_key` so
  -- re-running this migration never duplicates them.
  system_template_key text,
  name                text not null,
  description         text,
  -- Same vocabulary as ai_agents.purpose. Constrains which tool
  -- grants + channels the builder will offer.
  purpose             text not null
                        check (purpose in ('customer_support', 'admin_operations', 'custom')),
  -- Version of the template. Bumping creates a new row; older
  -- clones keep pointing at their source via source_template_id.
  version             integer not null default 1,
  -- Default revision fields the builder prefills.
  default_settings    jsonb not null default '{}'::jsonb,
  -- Tool keys the template suggests. The builder intersects
  -- these with the runtime registry at draft time — unknown
  -- keys are dropped with a UI warning.
  suggested_tool_keys jsonb not null default '[]'::jsonb,
  -- Required policy acknowledgements (e.g. "no data exfil").
  required_policies   jsonb not null default '[]'::jsonb,
  is_active           boolean not null default true,
  source_template_id  uuid references public.ai_agent_templates(id) on delete set null,
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- One system template per (key, version).
create unique index if not exists ai_agent_templates_system_key_uidx
  on public.ai_agent_templates (system_template_key, version)
  where system_template_key is not null;

create index if not exists ai_agent_templates_account_idx
  on public.ai_agent_templates (account_id, is_active);

alter table public.ai_agent_templates enable row level security;

drop policy if exists ai_agent_templates_select on public.ai_agent_templates;
create policy ai_agent_templates_select on public.ai_agent_templates for select
  using (
    -- System templates are readable by everyone; owned ones by
    -- the account's members.
    account_id is null or is_account_member(account_id)
  );

drop policy if exists ai_agent_templates_insert on public.ai_agent_templates;
create policy ai_agent_templates_insert on public.ai_agent_templates for insert
  with check (
    account_id is not null and is_account_member(account_id, 'admin')
  );

drop policy if exists ai_agent_templates_update on public.ai_agent_templates;
create policy ai_agent_templates_update on public.ai_agent_templates for update
  using (
    account_id is not null and is_account_member(account_id, 'admin')
  );

drop policy if exists ai_agent_templates_delete on public.ai_agent_templates;
create policy ai_agent_templates_delete on public.ai_agent_templates for delete
  using (
    account_id is not null and is_account_member(account_id, 'admin')
  );

create or replace function public.update_ai_agent_templates_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists ai_agent_templates_updated_at on public.ai_agent_templates;
create trigger ai_agent_templates_updated_at
  before update on public.ai_agent_templates
  for each row execute function public.update_ai_agent_templates_updated_at();

-- ------------------------------------------------------------
-- 2) Seed the 5 system templates (plan §4)
-- ------------------------------------------------------------
-- The unique index above is partial (system_template_key IS NOT
-- NULL), so PostgreSQL cannot infer it from
-- ON CONFLICT (system_template_key, version). Use a NOT EXISTS
-- guard instead; this remains idempotent and works on both a
-- clean database and a partially-applied migration.
insert into public.ai_agent_templates
  (account_id, system_template_key, name, description, purpose, version, default_settings, suggested_tool_keys, required_policies)
select v.account_id, v.system_template_key, v.name, v.description, v.purpose, v.version,
       v.default_settings, v.suggested_tool_keys, v.required_policies
from (
  values
    (null::uuid, 'customer_service', 'Customer service',
     'General answers with human handoff. Knowledge + service lookups only.',
     'customer_support', 1,
     '{"response_style":"balanced","language_policy":"auto","max_tool_rounds":3,"max_ai_replies_per_conversation":3}'::jsonb,
     '["services.search","services.get","pricing.calculate_quote"]'::jsonb,
     '["no_data_exfiltration","handoff_on_uncertainty"]'::jsonb),
    (null::uuid, 'services_pricing', 'Services & pricing',
     'Explains services, computes quotes, and reads live FX rates.',
     'customer_support', 1,
     '{"response_style":"concise","language_policy":"auto","max_tool_rounds":4,"max_ai_replies_per_conversation":5}'::jsonb,
     '["services.search","pricing.calculate_quote","exchange_rates.get_current"]'::jsonb,
     '["no_data_exfiltration","quote_disclaimer"]'::jsonb),
    (null::uuid, 'coverage', 'Coverage',
     'Collects requirements and reports aggregated availability. Proposals disabled by default.',
     'customer_support', 1,
     '{"response_style":"balanced","language_policy":"auto","max_tool_rounds":4,"max_ai_replies_per_conversation":5}'::jsonb,
     '["services.search","coverage.check_availability"]'::jsonb,
     '["no_data_exfiltration","no_provider_identity"]'::jsonb),
    (null::uuid, 'admin_services', 'Admin services',
     'Works from a trusted admin number. propose_* tools only; no direct writes.',
     'admin_operations', 1,
     '{"response_style":"concise","language_policy":"auto","max_tool_rounds":6,"max_ai_replies_per_conversation":10}'::jsonb,
     '["services.search","pricing.calculate_quote","exchange_rates.get_current"]'::jsonb,
     '["trusted_admin_plane","explicit_approval_required"]'::jsonb),
    (null::uuid, 'triage', 'Conversation triage',
     'Classifies / tags / routes conversations per registered tools. Never sends copy.',
     'custom', 1,
     '{"response_style":"balanced","language_policy":"auto","max_tool_rounds":2,"max_ai_replies_per_conversation":0}'::jsonb,
     '[]'::jsonb,
     '["no_customer_copy"]'::jsonb)
) as v(
  account_id, system_template_key, name, description, purpose, version,
  default_settings, suggested_tool_keys, required_policies
)
where not exists (
  select 1
    from public.ai_agent_templates existing
   where existing.system_template_key = v.system_template_key
     and existing.version = v.version
);

-- ------------------------------------------------------------
-- 3) ai_agent_test_cases
-- ------------------------------------------------------------
create table if not exists public.ai_agent_test_cases (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  agent_id      uuid not null references public.ai_agents(id) on delete cascade,
  name          text not null,
  -- 'customer' | 'admin' — which plane the inbound simulates.
  plane         text not null default 'customer'
                  check (plane in ('customer', 'admin')),
  -- The inbound message(s) the test sends (max 3 turns).
  input_messages jsonb not null default '[]'::jsonb,
  -- Structured assertions, validated by the evaluation runner:
  --   { tool_must_call?: string[], tool_must_not_call?: string[],
  --     handoff_required?: boolean, must_not_leak?: string[],
  --     response_matches?: { kind: 'regex', pattern: string } }
  assertions    jsonb not null default '{}'::jsonb,
  is_required   boolean not null default false,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists ai_agent_test_cases_agent_idx
  on public.ai_agent_test_cases (agent_id, is_required);

alter table public.ai_agent_test_cases enable row level security;

drop policy if exists ai_agent_test_cases_select on public.ai_agent_test_cases;
create policy ai_agent_test_cases_select on public.ai_agent_test_cases for select
  using (is_account_member(account_id));

drop policy if exists ai_agent_test_cases_insert on public.ai_agent_test_cases;
create policy ai_agent_test_cases_insert on public.ai_agent_test_cases for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists ai_agent_test_cases_update on public.ai_agent_test_cases;
create policy ai_agent_test_cases_update on public.ai_agent_test_cases for update
  using (is_account_member(account_id, 'admin'));

drop policy if exists ai_agent_test_cases_delete on public.ai_agent_test_cases;
create policy ai_agent_test_cases_delete on public.ai_agent_test_cases for delete
  using (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- 4) ai_agent_evaluation_runs
-- ------------------------------------------------------------
create table if not exists public.ai_agent_evaluation_runs (
  id               uuid primary key default gen_random_uuid(),
  account_id       uuid not null references accounts(id) on delete cascade,
  agent_id         uuid not null references public.ai_agents(id) on delete cascade,
  revision_id      uuid not null references public.ai_agent_revisions(id) on delete cascade,
  -- 'running' | 'passed' | 'failed' | 'error'.
  status           text not null default 'running'
                     check (status in ('running', 'passed', 'failed', 'error')),
  -- Per-case results: [{ test_case_id, passed, tool_calls, response, violations }]
  results          jsonb not null default '[]'::jsonb,
  total_cases      integer not null default 0,
  failed_cases     integer not null default 0,
  input_tokens     integer,
  output_tokens    integer,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz
);

create index if not exists ai_agent_evaluation_runs_agent_idx
  on public.ai_agent_evaluation_runs (agent_id, created_at desc);

alter table public.ai_agent_evaluation_runs enable row level security;

drop policy if exists ai_agent_evaluation_runs_select on public.ai_agent_evaluation_runs;
create policy ai_agent_evaluation_runs_select on public.ai_agent_evaluation_runs for select
  using (is_account_member(account_id));

drop policy if exists ai_agent_evaluation_runs_insert on public.ai_agent_evaluation_runs;
create policy ai_agent_evaluation_runs_insert on public.ai_agent_evaluation_runs for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists ai_agent_evaluation_runs_update on public.ai_agent_evaluation_runs;
create policy ai_agent_evaluation_runs_update on public.ai_agent_evaluation_runs for update
  using (is_account_member(account_id, 'admin'));

-- No DELETE policy — evaluation history is audit.

-- ------------------------------------------------------------
-- 5) ai_agent_budget_policies
-- ------------------------------------------------------------
create table if not exists public.ai_agent_budget_policies (
  id               uuid primary key default gen_random_uuid(),
  account_id       uuid not null references accounts(id) on delete cascade,
  -- NULL = account-wide policy; non-null = agent-specific.
  agent_id         uuid references public.ai_agents(id) on delete cascade,
  -- 'daily' | 'monthly'.
  period           text not null
                     check (period in ('daily', 'monthly')),
  max_runs         integer not null default 1000,
  max_input_tokens bigint not null default 1000000,
  max_output_tokens bigint not null default 500000,
  -- Soft threshold (0-1) triggers a warning; 1.0 (hard) blocks
  -- new runs and applies the fallback.
  soft_threshold   numeric(3, 2) not null default 0.80
                     check (soft_threshold between 0 and 1),
  -- 'handoff' | 'pause' | 'cheaper_agent'.
  hard_action      text not null default 'handoff'
                     check (hard_action in ('handoff', 'pause', 'cheaper_agent')),
  fallback_agent_id uuid references public.ai_agents(id) on delete set null,
  is_active        boolean not null default true,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- At most one policy per (account, agent, period). NULL agent
  -- rows use the account-wide slot.
  unique (account_id, agent_id, period)
);

create index if not exists ai_agent_budget_policies_account_idx
  on public.ai_agent_budget_policies (account_id, is_active);

alter table public.ai_agent_budget_policies enable row level security;

drop policy if exists ai_agent_budget_policies_select on public.ai_agent_budget_policies;
create policy ai_agent_budget_policies_select on public.ai_agent_budget_policies for select
  using (is_account_member(account_id));

drop policy if exists ai_agent_budget_policies_insert on public.ai_agent_budget_policies;
create policy ai_agent_budget_policies_insert on public.ai_agent_budget_policies for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists ai_agent_budget_policies_update on public.ai_agent_budget_policies;
create policy ai_agent_budget_policies_update on public.ai_agent_budget_policies for update
  using (is_account_member(account_id, 'admin'));

drop policy if exists ai_agent_budget_policies_delete on public.ai_agent_budget_policies;
create policy ai_agent_budget_policies_delete on public.ai_agent_budget_policies for delete
  using (is_account_member(account_id, 'admin'));

create or replace function public.update_ai_agent_budget_policies_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists ai_agent_budget_policies_updated_at on public.ai_agent_budget_policies;
create trigger ai_agent_budget_policies_updated_at
  before update on public.ai_agent_budget_policies
  for each row execute function public.update_ai_agent_budget_policies_updated_at();
