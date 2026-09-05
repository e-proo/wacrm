import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AiError } from '../types'
import { getAdapter } from '../providers/registry'
import { loadRuntimeConnection } from './loader'
import type { RuntimeConnection } from './types'
import { aiRequestTimeoutMs } from '../defaults'
import { EMBEDDING_DIMENSIONS } from '../embeddings'

// ============================================================
// Connection-based embeddings (Phase 05).
//
// Runs embeddings through the adapter `embed` seam — the same
// registry, runtime connections and validation as chat. The
// dimension gate is the hard safety rule of this initiative
// (ADR-008): the active KB index physically stores `vector(1536)`
// (migration 030), so ANY vector that is not exactly 1536 finite
// numbers must be rejected HERE, before any row/RPC touches the
// database. No truncation, no zero-padding, no mixing.
//
// The `dimensions` option is NEVER sent to providers in this phase:
// observed length is validated instead — passing an option we have
// not re-verified against live docs would be the exact assumption
// discipline forbids. text-embedding-3-small's official default is
// 1536, gemini's embedding outputs are checked at runtime, and a
// mismatch clearly reports observed vs required.
// ============================================================

const BATCH_SIZE = 96 // same conservative bound as the legacy path

export interface EmbeddingSetup {
  accountId: string
  embeddingConnectionId: string
  embeddingModel: string
  /** Active (ready) revision — null until re-index completes. */
  activeRevision: string | null
  /** Revision the next re-index should produce. */
  pendingRevision: string
  reindexState: string
}

/** Derive a stable, non-sensitive revision token. */
export function computeEmbeddingRevision(input: {
  protocol: string
  connectionId: string
  model: string
  dimensions: number
}): string {
  const h = createHash('sha256')
  h.update(
    `${input.protocol}|${input.connectionId}|${input.model.trim().toLowerCase()}|${input.dimensions}|v1`,
  )
  return `rev_${h.digest('hex').slice(0, 16)}`
}

/**
 * Validate a batch of vectors against the current index contract:
 * count matches, ordering preserved, every value a finite number,
 * every length EXACTLY the expected dimensions. Throws a safe
 * AiError before anything can be written.
 */
export function validateVectorsForIndex(
  vectors: number[][],
  expectedCount: number,
  dimensions: number = EMBEDDING_DIMENSIONS,
): void {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new AiError('Embeddings response had the wrong number of vectors.', {
      code: 'embeddings_malformed',
      status: 502,
    })
  }
  for (const vec of vectors) {
    if (!Array.isArray(vec)) {
      throw new AiError('Embeddings response missing a vector.', {
        code: 'embeddings_malformed',
        status: 502,
      })
    }
    if (vec.length !== dimensions) {
      throw new AiError(
        `Embeddings dimension mismatch: provider returned ${vec.length}, knowledge index requires ${dimensions}.`,
        { code: 'embedding_dimension_mismatch', status: 400 },
      )
    }
    for (const v of vec) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new AiError('Embeddings contained a non-finite value.', {
          code: 'embeddings_malformed',
          status: 502,
        })
      }
    }
  }
}

/**
 * Embed texts through a connection's adapter, batched and validated.
 * Returns vectors in input order. NEVER writes anything itself.
 */
export async function embedTextsViaConnection(
  conn: RuntimeConnection,
  model: string,
  inputs: string[],
): Promise<number[][]> {
  if (inputs.length === 0) return []
  const adapter = getAdapter(conn.protocol)
  if (!adapter.embed) {
    throw new AiError(`Provider ${conn.presetId} does not support embeddings.`, {
      code: 'ai_unsupported_capability',
      status: 400,
    })
  }
  const out: number[][] = []
  for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
    const batch = inputs.slice(start, start + BATCH_SIZE)
    const vectors = await adapter.embed(
      {
        apiKey: conn.apiKey,
        timeoutMs: aiRequestTimeoutMs(),
        apiRoot: conn.apiRoot,
        customEndpoint: conn.customEndpoint,
      },
      { model, inputs: batch },
    )
    validateVectorsForIndex(vectors, batch.length)
    out.push(...vectors)
  }
  return out
}

/**
 * Resolve the embedding setup + runtime connection for an account.
 * Returns null when the account is not on the connection-based path
 * (legacy `embeddings_api_key` keeps working until Phase 06 removal).
 */
export async function resolveEmbeddingConnection(
  db: SupabaseClient,
  accountId: string,
  setup: EmbeddingSetup,
): Promise<{ conn: RuntimeConnection; model: string } | null> {
  const conn = await loadRuntimeConnection(db, accountId, setup.embeddingConnectionId)
  void accountId
  return { conn, model: setup.embeddingModel }
}

export { EMBEDDING_DIMENSIONS, BATCH_SIZE }
