import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig, EmbeddingSetup } from '../types'
import { embedTexts, toVectorLiteral } from '../embeddings'
import { embedTextsViaConnection } from '../connections/embed'
import { loadRuntimeConnection } from '../connections/loader'
import { KNOWLEDGE_SECURITY_PREAMBLE } from './security'
import type { KnowledgeExcerpt, KnowledgeRetrievalScope } from './types'

export type KnowledgeEmbeddingContext = Pick<AiConfig, 'embeddingsApiKey'> & {
  embeddingSetup?: EmbeddingSetup | null
}

interface MatchRow {
  chunk_id: string
  document_id: string
  knowledge_base_id: string
  knowledge_base_name: string
  document_title: string
  content: string
  trust_level: KnowledgeExcerpt['trustLevel']
  source_type: KnowledgeExcerpt['sourceType']
  language: string
  updated_at: string
  rank?: number
  distance?: number
}

function semanticMode(ctx: KnowledgeEmbeddingContext): 'connection' | 'legacy' | null {
  const setup = ctx.embeddingSetup
  if (setup && setup.reindexState !== 'disabled' && setup.activeRevision) return 'connection'
  if (ctx.embeddingsApiKey) return 'legacy'
  return null
}

async function embedQuery(
  db: SupabaseClient,
  scope: KnowledgeRetrievalScope,
  ctx: KnowledgeEmbeddingContext,
  query: string,
  mode: 'connection' | 'legacy',
): Promise<number[]> {
  if (mode === 'connection') {
    const setup = ctx.embeddingSetup
    if (!setup) throw new Error('embedding setup missing')
    const runtime = await loadRuntimeConnection(db, scope.accountId, setup.embeddingConnectionId)
    const vectors = await embedTextsViaConnection(runtime, setup.embeddingModel, [query])
    if (!vectors[0]) throw new Error('query embedding missing')
    return vectors[0]
  }
  if (!ctx.embeddingsApiKey) throw new Error('legacy embeddings key missing')
  const vectors = await embedTexts(ctx.embeddingsApiKey, [query])
  if (!vectors[0]) throw new Error('query embedding missing')
  return vectors[0]
}

function toExcerpt(row: MatchRow, retrieval: 'semantic' | 'lexical'): KnowledgeExcerpt {
  const score = retrieval === 'semantic'
    ? 1 - Math.max(0, Number(row.distance ?? 1))
    : Number(row.rank ?? 0)
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    knowledgeBaseId: row.knowledge_base_id,
    knowledgeBaseName: row.knowledge_base_name,
    documentTitle: row.document_title,
    content: row.content ?? '',
    trustLevel: row.trust_level,
    sourceType: row.source_type,
    language: row.language ?? 'auto',
    updatedAt: row.updated_at,
    score,
    retrieval,
  }
}

/**
 * Dynamic hybrid retrieval. The model never supplies KB ids. Scope is derived
 * server-side from account + frozen agent revision, and SQL only reads active,
 * effective documents from explicitly assigned knowledge bases.
 */
export async function retrieveKnowledgeV2(
  db: SupabaseClient,
  scope: KnowledgeRetrievalScope,
  embedding: KnowledgeEmbeddingContext,
  queryText: string,
  k = 5,
): Promise<KnowledgeExcerpt[]> {
  const query = queryText.trim()
  if (!query || k <= 0) return []
  const max = Math.min(Math.max(k, 1), 20)
  const picked = new Map<string, KnowledgeExcerpt>()

  const mode = semanticMode(embedding)
  if (mode) {
    try {
      const vector = await embedQuery(db, scope, embedding, query, mode)
      const { data, error } = await db.rpc('match_ai_knowledge_v2_semantic', {
        p_account_id: scope.accountId,
        p_agent_revision_id: scope.agentRevisionId,
        p_query_embedding: toVectorLiteral(vector),
        p_match_count: Math.min(max * 3, 50),
        p_embedding_revision:
          mode === 'connection' ? embedding.embeddingSetup?.activeRevision ?? null : null,
        p_service_id: scope.serviceId ?? null,
        p_language: scope.language ?? null,
      })
      if (error) throw error
      for (const row of (data ?? []) as MatchRow[]) {
        if (picked.size >= max) break
        picked.set(row.chunk_id, toExcerpt(row, 'semantic'))
      }
    } catch (err) {
      // Semantic failure is not an authorization fallback. We may degrade to
      // FTS, but still through the same revision-scoped v2 SQL boundary.
      console.error('[ai knowledge v2] semantic retrieval failed:', err)
    }
  }

  if (picked.size < max) {
    try {
      const { data, error } = await db.rpc('match_ai_knowledge_v2_fts', {
        p_account_id: scope.accountId,
        p_agent_revision_id: scope.agentRevisionId,
        p_query: query,
        p_match_count: Math.min(max * 3, 50),
        p_service_id: scope.serviceId ?? null,
        p_language: scope.language ?? null,
      })
      if (error) throw error
      for (const row of (data ?? []) as MatchRow[]) {
        if (picked.size >= max) break
        if (!picked.has(row.chunk_id)) picked.set(row.chunk_id, toExcerpt(row, 'lexical'))
      }
    } catch (err) {
      console.error('[ai knowledge v2] lexical retrieval failed:', err)
    }
  }

  return [...picked.values()].slice(0, max)
}

/**
 * Render excerpts as clearly delimited JSON reference records. JSON prevents
 * ambiguous pseudo-role delimiters in document text from looking like prompt
 * structure. It is defense-in-depth; runtime authorization remains decisive.
 */
export function renderKnowledgeForPrompt(excerpts: readonly KnowledgeExcerpt[]): string[] {
  if (excerpts.length === 0) return []
  return [
    KNOWLEDGE_SECURITY_PREAMBLE,
    ...excerpts.map((excerpt, index) => JSON.stringify({
      kind: 'knowledge_reference',
      index: index + 1,
      knowledge_base: excerpt.knowledgeBaseName,
      document: excerpt.documentTitle,
      trust: excerpt.trustLevel,
      source: excerpt.sourceType,
      language: excerpt.language,
      updated_at: excerpt.updatedAt,
      content: excerpt.content,
    })),
  ]
}
