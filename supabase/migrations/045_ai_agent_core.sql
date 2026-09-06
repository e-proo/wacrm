-- ============================================================
-- 045_ai_agent_core.sql — Multi-agent AI core (Phase 1)
--
-- Introduces the "more than one AI agent per account" layer on top
-- of the existing single-config `ai_configs` / `ai_provider_connections`
-- foundation (migrations 029 / 040). This is an ADDITIVE expand step:
-- nothing in `ai_configs` is dropped or rewritten, and accounts that
-- never opt into the new path keep behaving identically.
--
-- Tables created here (all RLS-enabled, account-scoped, indexed):
--
--   ai_provider_connections  — additive columns only:
--     • legacy_ai_config_id  — backfill dedup key (idempotent migration)
--     • capabilities          — JSONB allowlist of supported models /
--                              features per the adapter's contract
--     • last_error_code       — safe (no secrets) error classifier
--
--   ai_agents                — agent identity row, system vs custom,
--                              status, published_revision_id pointer
--   ai_agent_revisions       — immutable snapshot of a configuration
--                              (provider + model + prompt + limits +
--                              knowledge assignment + tool grants).
--                              Publishing atomically swaps
--                              `ai_agents.published_revision_id`.
--   ai_agent_knowledge_assignments — per-revision assignment of an
--                              existing knowledge chunk to the agent
--                              (chunks stay account-owned; we only
--                              bind them to agents in revision scope).
--   ai_agent_tool_grants     — per-revision grants for tools registered
--                              in code. The grant only references a
--                              `(tool_key, tool_version)` pair; the
--                              handler lives in code, never in DB.
--
-- Multi-tenancy: every table carries `account_id NOT NULL` and is
-- covered by RLS that scopes reads/writes to the caller's account.
-- The admin/owner-only writes are gated by `is_account_member(...,
-- 'admin')` — same convention used by `ai_configs`.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Extend `ai_provider_connections` additively
-- ------------------------------------------------------------
alter table public.ai_provider_connections
  add column if not exists legacy_ai_config_id uuid
    references public.ai_configs(id) on delete set null,
  add column if not exists capabilities jsonb
    not null default '{}'::jsonb,
  add column if not exists last_error_code text;

-- One connection per legacy config (idempotent backfill safety).
create unique index if not exists ai_provider_connections_legacy_config_uidx
  on public.ai_provider_connections (legacy_ai_config_id)
  where legacy_ai_config_id is not null;

-- ------------------------------------------------------------
-- 2) ai_agents — the agent identity
-- ------------------------------------------------------------
create table if not exists public.ai_agents (
  id                        uuid primary key default gen_random_uuid(),
  account_id                uuid not null references accounts(id) on delete cascade,
  -- 'customer_service' | 'admin_operations' for the seeded system
  -- agents. NULL for user-created agents (Phase 4).
  system_key                text,
  slug                      text not null,
  name                      text not null,
  description               text,
  -- 'customer_support' | 'admin_operations' | 'custom'.
  purpose                   text not null default 'custom'
                              check (purpose in ('customer_support', 'admin_operations', 'custom')),
  -- 'draft' | 'active' | 'paused' | 'archived'. Draft is only valid
  -- when no published_revision_id is set; archived agents are kept
  -- for audit / history and cannot receive new runs.
  status                    text not null default 'draft'
                              check (status in ('draft', 'active', 'paused', 'archived')),
  -- Pointer to the currently-runnable revision. NULL while the agent
  -- is a draft. The FK is added separately so we can install the
  -- table first without a chicken-and-egg.
  published_revision_id     uuid,
  -- Optimistic-concurrency token for status mutations
  -- (pause/resume/archive). Bumped every UPDATE.
  version                   bigint not null default 1,
  created_by                uuid references auth.users(id) on delete set null,
  updated_by                uuid references auth.users(id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- system_key, when set, is unique per account so we can never seed
-- the same logical agent twice. NULL values can repeat (multiple
-- custom agents per account).
create unique index if not exists ai_agents_account_system_key_uidx
  on public.ai_agents (account_id, system_key)
  where system_key is not null;

-- Human-readable slug unique per account.
create unique index if not exists ai_agents_account_slug_uidx
  on public.ai_agents (account_id, slug);

create index if not exists ai_agents_account_status_idx
  on public.ai_agents (account_id, status);

alter table public.ai_agents enable row level security;

drop policy if exists ai_agents_select on public.ai_agents;
create policy ai_agents_select on public.ai_agents for select
  using (is_account_member(account_id));

drop policy if exists ai_agents_insert on public.ai_agents;
create policy ai_agents_insert on public.ai_agents for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists ai_agents_update on public.ai_agents;
create policy ai_agents_update on public.ai_agents for update
  using (is_account_member(account_id, 'admin'));

drop policy if exists ai_agents_delete on public.ai_agents;
create policy ai_agents_delete on public.ai_agents for delete
  using (is_account_member(account_id, 'admin'));

-- updated_at trigger
create or replace function public.update_ai_agents_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists ai_agents_updated_at on public.ai_agents;
create trigger ai_agents_updated_at
  before update on public.ai_agents
  for each row execute function public.update_ai_agents_updated_at();

-- ------------------------------------------------------------
-- 3) ai_agent_revisions — immutable configuration snapshot
-- ------------------------------------------------------------
create table if not exists public.ai_agent_revisions (
  id                              uuid primary key default gen_random_uuid(),
  account_id                      uuid not null references accounts(id) on delete cascade,
  agent_id                        uuid not null references public.ai_agents(id) on delete cascade,
  revision_number                 integer not null,
  -- 'draft' | 'published' | 'superseded' | 'rejected'. Once a
  -- revision is `published` its row is treated as immutable; the
  -- next change creates a new draft.
  status                          text not null default 'draft'
                                    check (status in ('draft', 'published', 'superseded', 'rejected')),
  provider_connection_id          uuid not null references public.ai_provider_connections(id) on delete restrict,
  model                           text not null,
  system_prompt                   text,
  -- 'concise' | 'balanced' | 'detailed' — UI sugar that the runtime
  -- maps to provider-neutral instructions.
  response_style                  text not null default 'balanced'
                                    check (response_style in ('concise', 'balanced', 'detailed')),
  -- 'auto' | 'ar' | 'en' | … — language hint surfaced to the prompt.
  language_policy                 text not null default 'auto',
  temperature                     numeric(3, 2),
  max_output_tokens               integer
                                    check (max_output_tokens is null or max_output_tokens between 1 and 32000),
  -- Foundation for Phase 3 tool-calling runtime; Phase 1 never
  -- grants `execute`-effect tools but reserves the column.
  max_tool_rounds                 integer not null default 0
                                    check (max_tool_rounds between 0 and 12),
  max_ai_replies_per_conversation integer not null default 3
                                    check (max_ai_replies_per_conversation between 0 and 20),
  -- Auth user id of the human handoff target (NULL = shared queue).
  handoff_human_member_id         uuid references auth.users(id) on delete set null,
  -- Bounded JSON of knobs the runtime knows about; rejects unknown
  -- keys at publish time (validation lives in app code).
  settings                        jsonb not null default '{}'::jsonb,
  created_by                      uuid references auth.users(id) on delete set null,
  created_at                      timestamptz not null default now(),
  published_by                    uuid references auth.users(id) on delete set null,
  published_at                    timestamptz,
  rejection_reason                text
);

create unique index if not exists ai_agent_revisions_agent_number_uidx
  on public.ai_agent_revisions (agent_id, revision_number);

create index if not exists ai_agent_revisions_account_status_idx
  on public.ai_agent_revisions (account_id, status);

alter table public.ai_agent_revisions enable row level security;

drop policy if exists ai_agent_revisions_select on public.ai_agent_revisions;
create policy ai_agent_revisions_select on public.ai_agent_revisions for select
  using (is_account_member(account_id));

drop policy if exists ai_agent_revisions_insert on public.ai_agent_revisions;
create policy ai_agent_revisions_insert on public.ai_agent_revisions for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists ai_agent_revisions_update on public.ai_agent_revisions;
create policy ai_agent_revisions_update on public.ai_agent_revisions for update
  using (is_account_member(account_id, 'admin'));

-- No DELETE policy on purpose — revisions are immutable history.

-- Now that the table exists, attach the FK from ai_agents.
-- PostgreSQL's ALTER TABLE ADD CONSTRAINT has no IF NOT EXISTS
-- support, so we drop (ignoring "doesn't exist") and then add.
do $$
begin
  begin
    alter table public.ai_agents
      drop constraint ai_agents_published_revision_fk;
  exception when undefined_object then
    null;
  end;
end$$;
alter table public.ai_agents
  add constraint ai_agents_published_revision_fk
  foreign key (published_revision_id)
  references public.ai_agent_revisions(id)
  on delete set null
  deferrable initially deferred;

-- ------------------------------------------------------------
-- 4) ai_agent_knowledge_assignments — per-revision KB binding
-- ------------------------------------------------------------
-- Knowledge CHUNKS (ai_knowledge_chunks) remain account-owned;
-- this join table decides which chunks the runtime is allowed to
-- pull into context for a given revision. We assign at the chunk
-- level (not document) so partial-doc retrieval still respects
-- per-revision scoping.
create table if not exists public.ai_agent_knowledge_assignments (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  agent_revision_id uuid not null references public.ai_agent_revisions(id) on delete cascade,
  knowledge_chunk_id  uuid not null references public.ai_knowledge_chunks(id) on delete cascade,
  -- Display/sort order hint. Smaller = earlier in retrieval.
  priority      integer not null default 100
                  check (priority between 0 and 1000),
  enabled       boolean not null default true,
  created_at    timestamptz not null default now()
);

-- A chunk may be bound to a revision at most once.
create unique index if not exists ai_agent_knowledge_assignments_rev_chunk_uidx
  on public.ai_agent_knowledge_assignments (agent_revision_id, knowledge_chunk_id);

create index if not exists ai_agent_knowledge_assignments_account_idx
  on public.ai_agent_knowledge_assignments (account_id);

alter table public.ai_agent_knowledge_assignments enable row level security;

drop policy if exists ai_agent_knowledge_assignments_select on public.ai_agent_knowledge_assignments;
create policy ai_agent_knowledge_assignments_select on public.ai_agent_knowledge_assignments for select
  using (is_account_member(account_id));

drop policy if exists ai_agent_knowledge_assignments_insert on public.ai_agent_knowledge_assignments;
create policy ai_agent_knowledge_assignments_insert on public.ai_agent_knowledge_assignments for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists ai_agent_knowledge_assignments_update on public.ai_agent_knowledge_assignments;
create policy ai_agent_knowledge_assignments_update on public.ai_agent_knowledge_assignments for update
  using (is_account_member(account_id, 'admin'));

drop policy if exists ai_agent_knowledge_assignments_delete on public.ai_agent_knowledge_assignments;
create policy ai_agent_knowledge_assignments_delete on public.ai_agent_knowledge_assignments for delete
  using (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- 5) ai_agent_tool_grants — per-revision tool allowances
-- ------------------------------------------------------------
-- Phase 1 only SEEDS the table; no `execute`-effect grants are
-- exposed to any model. The Phase 3 registry decides which (key,
-- version, effect) tuples are valid.
create table if not exists public.ai_agent_tool_grants (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references accounts(id) on delete cascade,
  agent_revision_id uuid not null references public.ai_agent_revisions(id) on delete cascade,
  tool_key          text not null,
  tool_version      integer not null default 1,
  -- 'read' | 'propose' | 'execute'. Phase 1 stores grants but the
  -- runtime never honours `execute` — execution is internal-only
  -- (Phase 3). The check is here for safety.
  permission        text not null
                      check (permission in ('read', 'propose', 'execute')),
  -- Bounded JSON: e.g. allowed service IDs, channels, time windows.
  -- Validated by the tool's own registry entry at grant-time and at
  -- run-time; unknown keys are rejected.
  constraints       jsonb not null default '{}'::jsonb,
  granted_by        uuid references auth.users(id) on delete set null,
  granted_at        timestamptz not null default now(),
  -- Same (revision, key) cannot appear twice.
  unique (agent_revision_id, tool_key)
);

create index if not exists ai_agent_tool_grants_account_idx
  on public.ai_agent_tool_grants (account_id);

alter table public.ai_agent_tool_grants enable row level security;

drop policy if exists ai_agent_tool_grants_select on public.ai_agent_tool_grants;
create policy ai_agent_tool_grants_select on public.ai_agent_tool_grants for select
  using (is_account_member(account_id));

drop policy if exists ai_agent_tool_grants_insert on public.ai_agent_tool_grants;
create policy ai_agent_tool_grants_insert on public.ai_agent_tool_grants for insert
  with check (is_account_member(account_id, 'admin'));

drop policy if exists ai_agent_tool_grants_update on public.ai_agent_tool_grants;
create policy ai_agent_tool_grants_update on public.ai_agent_tool_grants for update
  using (is_account_member(account_id, 'admin'));

drop policy if exists ai_agent_tool_grants_delete on public.ai_agent_tool_grants;
create policy ai_agent_tool_grants_delete on public.ai_agent_tool_grants for delete
  using (is_account_member(account_id, 'admin'));
