-- ============================================================
-- 042_ai_embeddings_revisions.sql — Embedding revisions for the
-- conservative re-index design (Phase 05, option (ب): previous
-- semantic revision keeps serving until the new one fully builds;
-- atomic activation; NO mixing — never relies on trust alone).
--
-- Guarantees encoded here:
--   1. The vector column stays vector(1536) — ADR-008 untouched.
--   2. Each chunk records WHICH revision produced its vector
--      (embedding_revision NULL = legacy OpenAI text-embedding-3-small).
--   3. The semantic RPC takes the active revision and matches rows with
--      IS NOT DISTINCT FROM — an inactive or half-built revision can
--      never appear in results.
--   4. ai_configs carries pending vs active revision + a bounded
--      re-index state machine ('legacy','pending','building','ready',
--      'failed','disabled').
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- config: revision + state machine
-- ------------------------------------------------------------
alter table public.ai_configs
  add column if not exists embedding_revision        text,
  add column if not exists embedding_pending_revision text,
  add column if not exists embedding_reindex_state   text
    not null default 'legacy'
    constraint ai_configs_embedding_reindex_state_check
    check (embedding_reindex_state in
      ('legacy','pending','building','ready','failed','disabled'));

-- ------------------------------------------------------------
-- chunks: per-vector provenance
-- ------------------------------------------------------------
alter table public.ai_knowledge_chunks
  add column if not exists embedding_revision text;

-- Supports the revision-filtered ANN path. Partial: lexical-only
-- (NULL embedding) rows are simply absent, mirroring 030's HNSW note.
create index if not exists ai_knowledge_chunks_embedding_revision_idx
  on public.ai_knowledge_chunks (account_id, embedding_revision)
  where embedding is not null;

-- ------------------------------------------------------------
-- usage log: accept the new protocol values
-- 033 checked provider IN ('openai','anthropic'); connection-based
-- chat (gemini_native) and future protocols must not break
-- best-effort usage logging. Additive widen, existing rows unaffected.
-- ------------------------------------------------------------
alter table public.ai_usage_log
  drop constraint if exists ai_usage_log_provider_check;
alter table public.ai_usage_log
  add constraint ai_usage_log_provider_check
  check (provider in ('openai','anthropic','gemini_native'));

-- ------------------------------------------------------------
-- retrieval RPC: revision-scoped semantic matching
-- ------------------------------------------------------------
-- Replace the 032 definition (which had no revision parameter). Old
-- callers pass three named arguments; PostgREST binds by name, and the
-- new default keeps them source-compatible.
drop function if exists public.match_ai_knowledge_semantic(uuid, text, integer);

create or replace function public.match_ai_knowledge_semantic(
  p_account_id      uuid,
  p_query_embedding text,
  p_match_count     integer,
  p_revision        text default null
)
returns table (id uuid, content text, distance real) as $$
  select c.id,
         c.content,
         (c.embedding <=> p_query_embedding::vector(1536)) as distance
  from ai_knowledge_chunks c
  where c.account_id = p_account_id
    and c.embedding is not null
    -- IS NOT DISTINCT FROM: NULL (legacy) revision only matches
    -- NULL (legacy) vectors; the active connection revision only
    -- matches its own stamped rows.
    and c.embedding_revision is not distinct from p_revision
  order by c.embedding <=> p_query_embedding::vector(1536)
  limit GREATEST(p_match_count, 0);
$$ language sql stable security definer set search_path = public;

-- Re-assert the lock-down exactly as 030/032 did (SECURITY DEFINER
-- without a revoke would re-open reading to anon).
revoke all on function public.match_ai_knowledge_semantic(uuid, text, integer, text) from public;
grant execute on function public.match_ai_knowledge_semantic(uuid, text, integer, text)
  to authenticated, service_role;
