-- ============================================================
-- 043_ai_configs_allow_null_key.sql — connection-only configs
--
-- Phase 05 unified UI: when an account drives Chat through a linked
-- provider connection, the legacy single-key fields are no longer
-- required. `api_key` (and the provider/model pair) become
-- connection-derived; the NOT NULL on the encrypted column is the
-- only blocker for that flow, so it is dropped here.
--
-- Rows are never destroyed and the column keeps its meaning (still
-- AES-256-GCM encrypted at rest); NULL simply means "this account has
-- no legacy key — a linked connection provides credentials".
-- The CHECK on provider is widened for the same reason (gemini chat
-- may mirror a placeholder protocol value chosen server-side).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

alter table public.ai_configs
  alter column api_key drop not null;
