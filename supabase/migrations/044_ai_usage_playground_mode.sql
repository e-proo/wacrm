-- ============================================================
-- 044_ai_usage_playground_mode.sql — usage accounting for every call site
--
-- Phase 06 follow-up from live testing: token usage was never visible
-- when an account works through a provider CONNECTION because (a) the
-- Playground surface did not log at all, and (b) gateways that omit a
-- usage block were skipped entirely (zero rows, so dashboards showed
-- nothing). This migration unblocks both:
--   1. `mode` accepts the new 'playground' surface.
--   2. `usage_reported` marks rows where the provider returned no
--      counts — calls are still billed-visible with zero tokens instead
--      of vanishing.
--   3. `connection_id` ties spend to the exact ai_provider_connection
--      (NULL = legacy single-key path).
--
-- Additive only; rows keep their meaning. Idempotent.
-- ============================================================

alter table public.ai_usage_log
  drop constraint if exists ai_usage_log_mode_check;
alter table public.ai_usage_log
  add constraint ai_usage_log_mode_check
  check (mode in ('auto_reply', 'draft', 'playground'));

alter table public.ai_usage_log
  add column if not exists usage_reported boolean not null default true,
  add column if not exists connection_id uuid
    references public.ai_provider_connections (id) on delete set null;

create index if not exists ai_usage_log_connection_created_idx
  on public.ai_usage_log (connection_id, created_at desc)
  where connection_id is not null;
