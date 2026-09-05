import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'

/**
 * POST /api/ai/knowledge/reindex  (admin+)
 *
 * Re-chunk and re-embed every document in the account. Two paths:
 *
 * LEGACY (OpenAI embeddings key or no key): unchanged behavior — each
 * document gets its vectors with a NULL revision stamp and semantic
 * search (revision-unfiltered by SQL default) works on completion.
 *
 * CONNECTION (Phase 05): a full rebuild with zero semantic downtime —
 * chunk rows are STAMPED with the pending revision (per-document
 * deletion is scoped to that revision), so the old ACTIVE revision
 * stays complete and keeps serving retrieval the whole time. Success
 * flips pending→active in ONE update (atomic activation; the previous
 * revision is retired — not deleted — in this release; deletion is a
 * Phase-06 contract concern). Any failure parks state at 'failed'
 * with the old space still live and lexical search intact.
 * A 400/502 on a dimension mismatch is a provider config error — the
 * admin must pick a 1536-dim model (ADR-008; index column is fixed).
 */
export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb-reindex:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { data: docs, error } = await supabase
      .from('ai_knowledge_documents')
      .select('id, content')
      .eq('account_id', accountId)
    if (error) {
      console.error('[ai/knowledge/reindex] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load documents' }, { status: 500 })
    }

    const {
      key: embeddingsApiKey,
      corrupt,
      embedSetup,
    } = await loadEmbeddingsKey(supabase, accountId)

    // ------------------------------------------------------------
    // Connection path — full state machine
    // ------------------------------------------------------------
    if (embedSetup) {
      const pending = embedSetup.pendingRevision
      if (!pending) {
        return NextResponse.json(
          {
            success: false,
            error_code: 'AI_CONFIG_CONFLICT',
            error: 'No embedding revision is queued. Save an embeddings connection+model first.',
          },
          { status: 400 },
        )
      }

      const mark = async (state: 'building' | 'ready' | 'failed') => {
        const patch: Record<string, unknown> = { embedding_reindex_state: state }
        if (state === 'ready') {
          // ATOMIC activation: the just-built revision becomes searchable.
          patch.embedding_revision = pending
          patch.embedding_pending_revision = null
        }
        const { error: updErr } = await supabase
          .from('ai_configs')
          .update(patch)
          .eq('account_id', accountId)
        if (updErr) console.error('[ai/knowledge/reindex] state update failed:', updErr)
      }

      await mark('building')

      let reindexed = 0
      for (const doc of docs ?? []) {
        try {
          await ingestDocument(
            supabase,
            accountId,
            { embeddingsApiKey, embeddingSetup: embedSetup },
            doc.id,
            doc.content,
          )
          reindexed += 1
        } catch (err) {
          // Any doc failure parks the whole rebuild — retrieval stays
          // lexical and the previous revision (if any) is NOT removed.
          await mark('failed')
          const code = err instanceof AiError ? err.code : 'internal'
          const safeMessage =
            code === 'embedding_dimension_mismatch'
              ? 'Re-index stopped: the selected embeddings model does not produce 1536-dimensional vectors (required by the knowledge index). Choose a 1536-dim model and re-run.'
              : `Re-index stopped after ${reindexed}/${(docs ?? []).length} documents (${
                  code === 'internal' ? 'an internal error' : 'a provider error'
                }). The previous semantic index and keyword search still work; fix the connection and re-run.`
          console.error(
            `[ai/knowledge/reindex] doc ${doc.id} failed (safe code):`,
            err instanceof AiError ? err.message : String(err),
          )
          return NextResponse.json(
            {
              success: false,
              state: 'failed',
              reindexed,
              total: (docs ?? []).length,
              error_code:
                code === 'embedding_dimension_mismatch'
                  ? 'AI_EMBEDDING_DIMENSION_MISMATCH'
                  : code,
              error: safeMessage,
            },
            { status: 200 },
          )
        }
      }

      await mark('ready')
      return NextResponse.json({
        success: true,
        state: 'ready',
        revision: pending,
        reindexed,
        message: `Semantic index rebuilt (${reindexed} documents) and activated.`,
      })
    }

    // ------------------------------------------------------------
    // Legacy path — unchanged semantics
    // ------------------------------------------------------------
    // The whole point of Reindex is usually to backfill embeddings — so
    // if a key is configured but can't be decrypted, don't quietly do a
    // lexical-only pass and report success. Stop and tell the admin.
    if (corrupt) {
      return NextResponse.json(
        {
          success: false,
          reindexed: 0,
          error:
            'Your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key in Settings → AI Assistant). Nothing was reindexed.',
        },
        { status: 200 },
      )
    }

    let reindexed = 0
    for (const doc of docs ?? []) {
      try {
        await ingestDocument(supabase, accountId, { embeddingsApiKey }, doc.id, doc.content)
        reindexed += 1
      } catch (err) {
        // One bad document (e.g. a mid-run embeddings rate-limit) should
        // not abort the whole batch.
        const message = err instanceof AiError ? err.message : String(err)
        console.error(`[ai/knowledge/reindex] doc ${doc.id} failed:`, message)
        return NextResponse.json(
          {
            success: false,
            reindexed,
            total: (docs ?? []).length,
            error: `Reindexed ${reindexed}, then hit an error: ${message}`,
          },
          { status: 200 },
        )
      }
    }

    return NextResponse.json({ success: true, reindexed })
  } catch (err) {
    return toErrorResponse(err)
  }
}
