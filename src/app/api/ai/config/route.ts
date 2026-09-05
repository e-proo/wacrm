import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { validateAiCredentials } from '@/lib/ai/validate'
import { embedTexts, EMBEDDING_DIMENSIONS } from '@/lib/ai/embeddings'
import { multiProviderEnabled } from '@/lib/ai/config'
import { getAdapter } from '@/lib/ai/providers/registry'
import { computeEmbeddingRevision } from '@/lib/ai/connections/embed'
import { AiError, type AiConnectionProtocol, type AiProvider } from '@/lib/ai/types'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

interface OwnedConnection {
  id: string
  protocol: string
  preset_id: string
  status: string
}

/** Validate a connection id belongs to this account (defense in depth
 *  on top of RLS) and return its row essentials. Only meaningful with
 *  the flag on; used exclusively for Phase 05 link columns. */
async function loadOwnedConnection(
  db: SupabaseClient,
  accountId: string,
  id: string,
): Promise<OwnedConnection | null> {
  const { data, error } = await db
    .from('ai_provider_connections')
    .select('id, protocol, preset_id, status')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw error
  return (data as OwnedConnection | null) ?? null
}

/**
 * GET /api/ai/config
 *
 * Any member may read the config so the inbox/settings can reflect
 * whether AI is set up. The encrypted key is NEVER returned — only a
 * `has_key` flag; the settings form shows a masked placeholder.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('ai_configs')
      // `api_key` is selected only to derive `has_key` — it is stripped
      // out below and never returned to the client. The Phase 05 link
      // columns are ids/flags only — never secrets.
      .select(
        'provider, model, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, api_key, embeddings_api_key, chat_connection_id, chat_model, embedding_connection_id, embedding_model, embedding_dimensions, embedding_revision, embedding_pending_revision, embedding_reindex_state',
      )
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[ai/config GET] fetch error:', error)
      return NextResponse.json(
        { error: 'Failed to load AI configuration' },
        { status: 500 },
      )
    }

    if (!data) return NextResponse.json({ configured: false, multi_provider_enabled: multiProviderEnabled() })
    // The keys are selected only to derive the has_* flags; neither is
    // returned to the client.
    const { api_key, embeddings_api_key, ...safe } = data
    return NextResponse.json({
      configured: true,
      has_key: !!api_key,
      has_embeddings_key: !!embeddings_api_key,
      multi_provider_enabled: multiProviderEnabled(),
      ...safe,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/config  (admin+)
 *
 * Upsert the account's AI config. Validates the key with the provider
 * before persisting (mirrors the WhatsApp config verifying with Meta
 * first), then stores the key AES-256-GCM-encrypted. When `api_key` is
 * omitted the existing stored key is reused (the form sends it only
 * when the user re-enters it).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`ai-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    // provider/model are resolved AFTER the existing row + chat
    // connection are loaded (below): when a chat connection is linked,
    // the legacy columns become CONNECTION-DERIVED so the merged
    // Settings form has exactly one source for provider identity.
    // `existing` is loaded first: the update path must not trust
    // anything a client omitted (e.g. a hidden legacy card's fields).

    const systemPrompt =
      typeof body.system_prompt === 'string' && body.system_prompt.trim()
        ? body.system_prompt.trim()
        : null
    const isActive = body.is_active === true
    const autoReplyEnabled = body.auto_reply_enabled === true

    let maxPer = Number(body.auto_reply_max_per_conversation)
    if (!Number.isFinite(maxPer)) maxPer = 3
    maxPer = Math.min(20, Math.max(1, Math.floor(maxPer)))

    // Handoff routing target for auto-reply. A non-empty string must be a
    // member of this account (else the conversation would be assigned to a
    // stranger); an empty string / null means "leave unassigned" (the
    // shared queue). Absent → left unchanged on update below.
    const rawHandoff =
      typeof body.handoff_agent_id === 'string' ? body.handoff_agent_id.trim() : ''
    const handoffProvided = 'handoff_agent_id' in body
    let handoffAgentId: string | null = null
    if (rawHandoff) {
      const { data: member } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('account_id', accountId)
        .eq('user_id', rawHandoff)
        .maybeSingle()
      if (!member) return bad('handoff_agent_id must be a member of this account')
      handoffAgentId = rawHandoff
    }

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''

    // Embeddings key (optional, for semantic KB search): a non-empty
    // string sets/replaces it; an explicit null clears it; absent leaves
    // it unchanged. The form only sends it when the admin edits it.
    const rawEmbeddingsKey =
      typeof body.embeddings_api_key === 'string'
        ? body.embeddings_api_key.trim()
        : ''
    const clearEmbeddingsKey = body.embeddings_api_key === null

    // Reuse the stored key when the form didn't send a fresh one.
    const { data: existing } = await supabase
      .from('ai_configs')
      .select(
        'id, provider, model, api_key, chat_connection_id, chat_model, embedding_connection_id, embedding_model, embedding_revision, embedding_pending_revision',
      )
      .eq('account_id', accountId)
      .maybeSingle()
    const existingRow = existing as
      | {
          id: string
          provider: string
          model: string
          api_key: string
          chat_connection_id: string | null
          chat_model: string | null
          embedding_connection_id: string | null
          embedding_model: string | null
          embedding_revision: string | null
          embedding_pending_revision: string | null
        }
      | null

    // ---- resolve the chat link FIRST: it decides whether the legacy
    // provider/model/key contract below applies at all ----
    const flagOn = multiProviderEnabled()
    let chatConn: OwnedConnection | null = null
    if ('chat_connection_id' in body && body.chat_connection_id !== null && body.chat_connection_id !== '') {
      if (
        flagOn &&
        typeof body.chat_connection_id === 'string' &&
        /^[0-9a-f-]{36}$/i.test(body.chat_connection_id.trim())
      ) {
        const found = await loadOwnedConnection(supabase, accountId, body.chat_connection_id.trim())
        if (!found) return bad('chat_connection_id must reference one of your own connections')
        chatConn = found
      } else {
        return bad('chat_connection_id is invalid')
      }
    }

    let provider: AiProvider
    let model: string
    if (chatConn) {
      // Connection-derived: the legacy columns mirror the connection's
      // protocol family (gemini_native has no legacy family — 'openai'
      // is a harmless placeholder; generation uses the connection).
      provider = chatConn.protocol === 'anthropic' ? 'anthropic' : 'openai'
      model = typeof body.chat_model === 'string' ? body.chat_model.trim() : ''
      if (!model || model.length > 200) {
        return bad('chat_model is required (max 200 chars) when a chat connection is selected')
      }
    } else {
      provider = body.provider as AiProvider
      if (provider !== 'openai' && provider !== 'anthropic') {
        return bad('provider must be "openai" or "anthropic"')
      }
      model = typeof body.model === 'string' ? body.model.trim() : ''
      if (!model) return bad('model is required')
    }

    // Legacy key resolution — OPTIONAL when a chat connection carries
    // the credentials (migration 043 allows a NULL api_key column).
    let apiKeyPlain: string | null = null
    if (rawKey) {
      apiKeyPlain = rawKey
    } else if (existing?.api_key) {
      try {
        apiKeyPlain = decrypt(existing.api_key)
      } catch {
        return bad('Stored API key could not be decrypted — re-enter your key.')
      }
    } else if (!chatConn) {
      return bad('api_key is required')
    }

    // Only spend a provider round-trip when the credentials that affect
    // reachability actually changed. A save that just flips a toggle or
    // edits the system prompt on an existing, already-validated config
    // skips the call — no wasted token/latency on the account's key.
    // With a chat connection there is nothing legacy to validate at all:
    // the connection was verified through its own probe routes.
    const credentialsChanged =
      !chatConn &&
      (!existing ||
        rawKey !== '' ||
        provider !== existing.provider ||
        model !== existing.model)

    if (credentialsChanged && apiKeyPlain) {
      try {
        await validateAiCredentials({
          provider,
          model,
          apiKey: apiKeyPlain,
          systemPrompt,
          isActive,
          autoReplyEnabled,
          autoReplyMaxPerConversation: maxPer,
          handoffAgentId: null,
          embeddingsApiKey: null,
        })
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: err.message, code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] validation error:', err)
        return bad('Could not validate the API key with the provider.')
      }
    }

    // Validate a new embeddings key before storing (a cheap 1-input
    // embed), same "verify before save" discipline as the chat key.
    if (rawEmbeddingsKey) {
      try {
        await embedTexts(rawEmbeddingsKey, ['ping'])
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: `Embeddings key: ${err.message}`, code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] embeddings validation error:', err)
        return bad('Could not validate the embeddings key.')
      }
    }

    const encryptedKey = rawKey ? encrypt(rawKey) : null
    const shared: Record<string, unknown> = {
      provider,
      model,
      system_prompt: systemPrompt,
      is_active: isActive,
      auto_reply_enabled: autoReplyEnabled,
      auto_reply_max_per_conversation: maxPer,
    }
    // Only touch the handoff target when the form actually sent the field,
    // so a partial save (e.g. flipping a toggle) doesn't wipe it.
    if (handoffProvided) shared.handoff_agent_id = handoffAgentId
    if (rawEmbeddingsKey) {
      shared.embeddings_api_key = encrypt(rawEmbeddingsKey)
    } else if (clearEmbeddingsKey) {
      shared.embeddings_api_key = null
    }

    // ------------------------------------------------------------
    // Phase 05 — connection links (flag-gated). A linked chat connection
    // overrides the legacy provider fields at generation time; a linked
    // embedding connection QUEUES a revision rebuild (state 'pending')
    // — semantic is never activated for an unverified selection, and
    // activation happens only when reindex succeeds (reindex route).
    // ------------------------------------------------------------
    if (flagOn) {
      const linkPatch: Record<string, unknown> = {}

      // ---- chat side ---- (connection already resolved above;
      // presence in body decides link/unlink)
      if ('chat_connection_id' in body) {
        linkPatch.chat_connection_id = chatConn ? chatConn.id : null
        if (chatConn) {
          linkPatch.chat_model = model // already validated non-empty
        } else {
          linkPatch.chat_model = null
        }
      }

      // ---- embeddings side ----
      if ('embedding_connection_id' in body || 'embedding_model' in body) {
        const clearing = body.embedding_connection_id === null && body.embedding_model === null
        if (clearing) {
          // Disconnect: revert to the legacy key path (state 'legacy'
          // simply means "revision machinery idle"; retrieval ignores it).
          linkPatch.embedding_connection_id = null
          linkPatch.embedding_model = null
          linkPatch.embedding_dimensions = null
          linkPatch.embedding_pending_revision = null
          linkPatch.embedding_reindex_state = 'legacy'
        } else {
          if (typeof body.embedding_connection_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.embedding_connection_id.trim())) {
            return bad('embedding_connection_id is required and must be a connection id')
          }
          if (typeof body.embedding_model !== 'string' || !body.embedding_model.trim() || body.embedding_model.length > 200) {
            return bad('embedding_model is required (max 200 chars)')
          }
          const conn = await loadOwnedConnection(supabase, accountId, body.embedding_connection_id.trim())
          if (!conn) return bad('embedding_connection_id must reference one of your own connections')
          const adapter = getAdapter(conn.protocol as AiConnectionProtocol)
          if (!adapter.embed) {
            // Reject BEFORE queueing a rebuild that can only fail.
            return bad('This connection\'s provider does not support embeddings.')
          }
          const model = body.embedding_model.trim()
          // NO-OP GUARD: re-saving the pair that is already selected must
          // NOT re-queue a rebuild (the UI always sends the current pair).
          const sameSelection =
            existingRow?.embedding_connection_id === conn.id &&
            existingRow?.embedding_model === model
          linkPatch.embedding_connection_id = conn.id
          linkPatch.embedding_model = model
          linkPatch.embedding_dimensions = EMBEDDING_DIMENSIONS
          if (!sameSelection) {
            linkPatch.embedding_pending_revision = computeEmbeddingRevision({
              protocol: conn.protocol,
              connectionId: conn.id,
              model,
              dimensions: EMBEDDING_DIMENSIONS,
            })
            // Selection change = queued rebuild. Semantic keeps serving the
            // PREVIOUS revision until the reindex flips state to 'ready'.
            linkPatch.embedding_reindex_state = 'pending'
          }
        }
      }

      Object.assign(shared, linkPatch)
    }

    if (existing) {
      const { error: upErr } = await supabase
        .from('ai_configs')
        .update(encryptedKey ? { ...shared, api_key: encryptedKey } : shared)
        .eq('account_id', accountId)
      if (upErr) {
        console.error('[ai/config POST] update error:', upErr)
        return NextResponse.json(
          { error: 'Failed to save AI configuration' },
          { status: 500 },
        )
      }
    } else {
      const { error: insErr } = await supabase.from('ai_configs').insert({
        account_id: accountId,
        created_by: userId,
        api_key: encryptedKey, // guaranteed non-null: rawKey required when no existing row
        ...shared,
      })
      if (insErr) {
        console.error('[ai/config POST] insert error:', insErr)
        return NextResponse.json(
          { error: 'Failed to save AI configuration' },
          { status: 500 },
        )
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/config  (admin+)
 *
 * Removes the account's AI config (turns everything off and forgets the
 * key). Also used to recover from a corrupted encrypted key.
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase
      .from('ai_configs')
      .delete()
      .eq('account_id', accountId)
    if (error) {
      console.error('[ai/config DELETE] error:', error)
      return NextResponse.json(
        { error: 'Failed to delete AI configuration' },
        { status: 500 },
      )
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
