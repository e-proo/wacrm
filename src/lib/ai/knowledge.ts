import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig, EmbeddingSetup } from './types'
import { chunkText } from './chunk'
import { embedTexts, toVectorLiteral } from './embeddings'
import { embedTextsViaConnection } from './connections/embed'

// ============================================================
// Knowledge base: ingest (chunk + optionally embed) and hybrid
// retrieve (semantic when embeddings are configured, topped up with
// lexical full-text search).
//
// Embeddings can come from EITHER source (dual-read by design):
//   • connection path (Phase 05 + flag): adapter `embed` with the
//     dimension gate BEFORE any DB write; new vectors are stamped with
//     a revision token and become searchable only after the pending
//     revision activates (never mixed with another model's space —
//     the SQL filter is `embedding_revision is not distinct from the
//     active revision`).
//   • legacy `embeddings_api_key` path: unchanged behavior (revision
//     NULL everywhere).
// ============================================================

interface MatchRow {
  id: string
  content: string
}

export type EmbeddingContext = Pick<AiConfig, 'embeddingsApiKey'> & {
  embeddingSetup?: EmbeddingSetup | null
}

/** Which revision new vectors written for this account should carry. */
function stampRevision(setup: EmbeddingSetup | null | undefined): string {
  if (!setup) return '' // legacy ⇒ NULL stamp
  // pending beats active: vectors produced while a rebuild is queued run
  // into the NEW space, invisible to the currently-served revision.
  return setup.pendingRevision ?? setup.activeRevision ?? ''
}

/**
 * Which embedding source serves a QUERY right now:
 *  • connection — only once the setup has an ACTIVE revision and is not
 *    explicitly disabled (a pending/building/failed rebuild keeps the
 *    previous revision serving);
 *  • legacy key — otherwise, when a key is present (this keeps semantic
 *    search on a connection account whose first rebuild has not
 *    activated yet — nothing is lost mid-migration);
 *  • null — lexical only.
 */
function semanticQueryMode(
  ctx: EmbeddingContext,
): 'connection' | 'legacy' | null {
  const setup = ctx.embeddingSetup
  if (setup && setup.reindexState !== 'disabled' && setup.activeRevision) {
    return 'connection'
  }
  if (ctx.embeddingsApiKey) return 'legacy'
  return null
}

/** Embed texts from the source indicated for this operation. */
async function embedWith(
  db: SupabaseClient,
  accountId: string,
  ctx: EmbeddingContext,
  texts: string[],
  source: 'connection' | 'legacy',
): Promise<number[][]> {
  if (source === 'connection') {
    const setup = ctx.embeddingSetup
    if (!setup) throw new Error('embedding setup missing')
    const { loadRuntimeConnection } = await import('./connections/loader')
    const runtime = await loadRuntimeConnection(db, accountId, setup.embeddingConnectionId)
    return embedTextsViaConnection(runtime, setup.embeddingModel, texts)
  }
  if (!ctx.embeddingsApiKey) throw new Error('embedWith called with no embedding source')
  return embedTexts(ctx.embeddingsApiKey, texts)
}

/**
 * (Re)build the chunks for one document. Deletes the document's
 * existing chunks, re-chunks the content, and — when the account has an
 * embeddings path — embeds each chunk. Runs under whatever client the
 * caller passes (service-role for ingest routes).
 *
 * Throws on embedding failure so the ingest route can report it; the
 * chunks are only written once embedding (if attempted) succeeds, so a
 * failed embed never leaves half-indexed rows. Dimension-mismatched
 * vectors are rejected before insert (no truncation/padding, no bad
 * write).
 */
export async function ingestDocument(
  db: SupabaseClient,
  accountId: string,
  ctx: EmbeddingContext,
  documentId: string,
  content: string,
): Promise<void> {
  const chunks = chunkText(content)

  // Replace, don't append — re-ingest must be idempotent PER REVISION.
  // Only this document's chunks of the target revision are deleted, so a
  // rebuild into a pending revision never destroys the revision that is
  // currently serving search (old vectors are retired — not deleted —
  // when the pending revision activates).
  const del = db
    .from('ai_knowledge_chunks')
    .delete()
    .eq('document_id', documentId)
  const stampForDelete = stampRevision(ctx.embeddingSetup)
  const scoped = stampForDelete
    ? del.eq('embedding_revision', stampForDelete)
    : del.is('embedding_revision', null)
  const { error: delErr } = await scoped
  if (delErr) throw delErr

  if (chunks.length === 0) return

  // Embed if configured, but DON'T let an embedding failure stop the
  // chunks from being stored: a failed embed must still leave the
  // document searchable lexically. We record the error and rethrow it
  // AFTER inserting (embedding-less) rows, so the route can warn
  // "semantic indexing failed" — which is now truthful, because lexical
  // search really does still work.
  let embeddings: number[][] | null = null
  let embedError: unknown = null
  // Ingest writes into the space the ADMIN selected: a connected
  // embeddings setup always wins for new writes (stamped pending/active);
  // accounts that never linked one keep the legacy key path.
  const writeSource: 'connection' | 'legacy' | null = ctx.embeddingSetup
    ? 'connection'
    : ctx.embeddingsApiKey
      ? 'legacy'
      : null
  if (writeSource) {
    try {
      embeddings = await embedWith(db, accountId, ctx, chunks, writeSource)
    } catch (err) {
      embedError = err
    }
  }
  const revision = stampRevision(ctx.embeddingSetup)

  const rows = chunks.map((chunkContent, i) => ({
    document_id: documentId,
    account_id: accountId,
    chunk_index: i,
    content: chunkContent,
    embedding: embeddings ? toVectorLiteral(embeddings[i]) : null,
    // '' → write NULL (legacy space); token → stamped revision.
    embedding_revision: revision || null,
  }))

  const { error: insErr } = await db.from('ai_knowledge_chunks').insert(rows)
  if (insErr) throw insErr

  if (embedError) throw embedError
}

/**
 * Retrieve up to `k` knowledge excerpts relevant to `queryText`.
 *
 * Semantic-primary when embeddings are configured (embed the query →
 * cosine-nearest chunks IN THE ACTIVE REVISION ONLY), then topped up
 * with lexical full-text matches to fill `k`. Lexical-only when there
 * is no semantic space configured yet (never configured, semantic
 * disabled, or still pending/failed re-index). Best-effort: any
 * failure (no KB, embedding error, RPC error) degrades to fewer or
 * zero results and never throws into the draft / auto-reply path.
 */
export interface RetrieveKnowledgeOptions {
  /**
   * When set, retrieval is SCOPED to the chunks assigned to this
   * agent revision (ai_agent_knowledge_assignments). An agent with
   * assignments sees only its assigned chunks; with NO assignments
   * it falls back to the whole account KB (backward compatible).
   */
  scopeRevisionId?: string
}

export async function retrieveKnowledge(
  db: SupabaseClient,
  accountId: string,
  config: EmbeddingContext,
  queryText: string,
  k = 5,
  opts: RetrieveKnowledgeOptions = {},
): Promise<string[]> {
  const query = queryText.trim()
  if (!query || k <= 0) return []

  // Per-revision scoping: resolve the allowed chunk set ONCE (one
  // cheap read). No assignments for the revision → no restriction
  // (legacy accounts keep working); assignments present → they are
  // the whitelist, and post-filtering below enforces it on BOTH the
  // semantic and lexical paths.
  let allowedIds: Set<string> | null = null
  if (opts.scopeRevisionId) {
    const { data: assignments, error } = await db
      .from('ai_agent_knowledge_assignments')
      .select('knowledge_chunk_id, enabled')
      .eq('agent_revision_id', opts.scopeRevisionId)
    if (error) {
      console.error('[ai knowledge] assignment scope read failed:', error)
    } else if (assignments && assignments.length > 0) {
      allowedIds = new Set(
        (assignments as Array<{ knowledge_chunk_id: string; enabled: boolean }>)
          .filter((a) => a.enabled)
          .map((a) => a.knowledge_chunk_id),
      )
      if (allowedIds.size === 0) return []
    }
  }

  // Skip everything when the account has no knowledge base — otherwise
  // every draft / auto-reply would pay for a query embedding + two RPCs
  // just to get []. One cheap indexed COUNT (head, no rows) instead of a
  // paid embeddings call on the hot path.
  try {
    const { count, error } = await db
      .from('ai_knowledge_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
    if (error || !count) return []
  } catch {
    return []
  }

  const picked = new Map<string, string>() // id → content, preserves order

  // Resolve which semantic space (if any) is live.
  //  • connection: the ACTIVE revision serves search in every state
  //    except 'disabled' — including while a newer revision is
  //    pending/building/failed. Because the rebuild stamps chunk rows
  //    with the PENDING revision, the old space stays complete and
  //    untouched until activation flips the token (docs: keep the
  //    previous revision until the new one succeeds — never mix).
  //  • legacy: usable when an embeddings key is present (unchanged).
  // Which semantic source is live right now (see semanticQueryMode).
  const querySource = semanticQueryMode(config)
  let queryEmbedding: number[] | null = null

  if (querySource) {
    try {
      queryEmbedding = (await embedWith(db, accountId, config, [query], querySource))[0] ?? null
    } catch (err) {
      console.error('[ai knowledge] query embedding failed, falling back to FTS:', err)
      return lexicalTopUp(db, accountId, query, picked, k)
    }
  }

  // Semantic path.
  if (queryEmbedding) {
    try {
      const { data, error } = await db.rpc('match_ai_knowledge_semantic', {
        p_account_id: accountId,
        p_query_embedding: toVectorLiteral(queryEmbedding),
        p_match_count: k,
        // Connection queries scope to the ACTIVE revision; the legacy key
        // path passes NO p_revision, hitting the SQL default (`null`) so
        // it keeps matching the un-stamped (NULL) rows — no behavior change.
        ...(querySource === 'connection'
          ? { p_revision: config.embeddingSetup!.activeRevision }
          : {}),
      })
      if (!error && Array.isArray(data)) {
        for (const row of data as MatchRow[]) picked.set(row.id, row.content ?? '')
      }
    } catch (err) {
      console.error('[ai knowledge] semantic retrieval failed, falling back to FTS:', err)
    }
  }

  const lexical = await lexicalTopUp(db, accountId, query, picked, k, allowedIds)
  return lexical
}

/** Lexical full-text top-up (also the sole path with no semantic space). */
async function lexicalTopUp(
  db: SupabaseClient,
  accountId: string,
  query: string,
  picked: Map<string, string>,
  k: number,
  allowedIds: Set<string> | null = null,
): Promise<string[]> {
  if (picked.size < k) {
    try {
      const { data, error } = await db.rpc('match_ai_knowledge_fts', {
        p_account_id: accountId,
        p_query: query,
        p_match_count: k,
      })
      if (!error && Array.isArray(data)) {
        for (const row of data as MatchRow[]) {
          if (picked.size >= k) break
          if (!picked.has(row.id)) picked.set(row.id, row.content ?? '')
        }
      }
    } catch (err) {
      console.error('[ai knowledge] lexical retrieval failed:', err)
    }
  }
  // Per-revision whitelist enforcement (single choke point).
  if (allowedIds) {
    return [...picked.entries()]
      .filter(([id]) => allowedIds.has(id))
      .map(([, content]) => content)
      .slice(0, k)
  }
  return Array.from(picked.values()).slice(0, k)
}
