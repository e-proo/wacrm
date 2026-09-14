-- ============================================================
-- 064_ai_knowledge_fts_any_word.sql
--
-- Why: match_ai_knowledge_fts (030/032) builds its tsquery with
-- plainto_tsquery, which ANDs EVERY word. A real customer
-- sentence like "كم عمولة التغطيات اليوم" only matches a chunk
-- containing every single word — for conversational Arabic that
-- is virtually never, so retrieveKnowledge returned 0 chunks
-- even with the whole KB assigned to the revision. The semantic
-- path cannot compensate while embeddings are unbuilt
-- (ai_knowledge_chunks.embedding IS NULL until a reindex runs).
--
-- Fix: ANY-WORD matching. A chunk qualifies when it contains any
-- query token; ts_rank still puts denser/multiple matches first,
-- so precision degrades gracefully instead of collapsing to zero.
-- Falls back to the old AND semantics when the OR form cannot be
-- parsed (punctuation/operator characters in the query).
--
-- Same signature, same SECURITY INVOKER mode as 032 — existing
-- grants and RLS behavior carry over untouched.
-- ============================================================

create or replace function public.match_ai_knowledge_fts(
  p_account_id  uuid,
  p_query       text,
  p_match_count integer
)
returns table (id uuid, content text, rank real)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_clean text := nullif(btrim(regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g')), '');
  v_tsq   tsquery;
begin
  if v_clean is null or greatest(coalesce(p_match_count, 0), 0) = 0 then
    return;
  end if;

  -- "word1 | word2 | …" — words themselves go through the same
  -- simple-config tokenizer used to build c.fts.
  begin
    v_tsq := to_tsquery('simple', replace(v_clean, ' ', ' | '));
  exception when others then
    v_tsq := null;
  end;

  if v_tsq is null or numnode(v_tsq) = 0 then
    v_tsq := plainto_tsquery('simple', v_clean);
  end if;

  if v_tsq is null or numnode(v_tsq) = 0 then
    return;
  end if;

  return query
  select
    c.id,
    c.content,
    ts_rank(c.fts, v_tsq)
  from ai_knowledge_chunks c
  where c.account_id = p_account_id
    and c.fts @@ v_tsq
  order by ts_rank(c.fts, v_tsq) desc, c.chunk_index asc
  limit greatest(p_match_count, 0);
end $$;
