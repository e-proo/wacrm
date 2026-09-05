import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { AiConfig, AiConnectionProtocol, EmbeddingSetup } from './types'
import { loadRuntimeConnection } from './connections/loader'

interface AiConfigRow {
  provider: 'openai' | 'anthropic'
  model: string
  api_key: string
  system_prompt: string | null
  is_active: boolean
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number
  handoff_agent_id: string | null
  embeddings_api_key: string | null
  // Phase 05 link columns (migration 040 / 042).
  chat_connection_id: string | null
  chat_model: string | null
  embedding_connection_id: string | null
  embedding_model: string | null
  embedding_dimensions: number | null
  embedding_revision: string | null
  embedding_pending_revision: string | null
  embedding_reindex_state: EmbeddingSetup['reindexState'] | null
}

const CONFIG_COLUMNS = [
  'provider',
  'model',
  'api_key',
  'system_prompt',
  'is_active',
  'auto_reply_enabled',
  'auto_reply_max_per_conversation',
  'handoff_agent_id',
  'embeddings_api_key',
  'chat_connection_id',
  'chat_model',
  'embedding_connection_id',
  'embedding_model',
  'embedding_dimensions',
  'embedding_revision',
  'embedding_pending_revision',
  'embedding_reindex_state',
].join(', ')

/** The expansion flag (also read by the connection API routes). */
export function multiProviderEnabled(): boolean {
  return process.env.AI_MULTI_PROVIDER_ENABLED === 'true'
}

/**
 * Load and decrypt the account's AI config for *use* (draft or
 * auto-reply). Returns `null` when there's no row or the master switch
 * (`is_active`) is off — both mean "AI is not available", which callers
 * treat identically. Throws only if the stored key can't be decrypted
 * (mismatched `ENCRYPTION_KEY`), so that distinct failure surfaces
 * rather than looking like "not configured".
 *
 * Works with any client: pass the RLS-scoped SSR client from a
 * dashboard route, or the service-role admin client from the webhook.
 *
 * Connection path (Phase 05, flag-gated): when the config links a chat
 * connection, the decrypted runtime connection drives generation
 * (protocol + root + key + `chat_model`), so accounts can chat on
 * Gemini/DeepSeek/… while the legacy columns keep serving un-migrated
 * accounts identically. An embedding connection adds `embeddingSetup`
 * for the KB retrieval/ingest paths. A corrupt linked connection
 * surfaces as an error (never a silent downgrade to a different key).
 */
export async function loadAiConfig(
  db: SupabaseClient,
  accountId: string,
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  const { requireActive = true } = opts
  const { data, error } = await db
    .from('ai_configs')
    .select(CONFIG_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as unknown as AiConfigRow
  // The Playground passes requireActive:false so an admin can test the
  // agent before flipping the master switch on.
  if (requireActive && !row.is_active) return null

  // Credentials may live EITHER place: a legacy key column OR a linked
  // chat connection. A config with neither cannot answer anything —
  // treat it as "not configured" (same null contract callers handle)
  // instead of crashing decrypt(null). MUST happen before any decrypt:
  // this replaces the old `!row.api_key` early-return that wrongly
  // rejected fully connection-driven configs.
  const hasChatLink = multiProviderEnabled() && !!row.chat_connection_id
  if (!row.api_key && !hasChatLink) return null

  // The embeddings key is optional and independent of the chat key —
  // a corrupt/undecryptable one should downgrade to lexical KB, not
  // take down draft/auto-reply, so decrypt failures are swallowed here.
  let embeddingsApiKey: string | null = null
  if (row.embeddings_api_key) {
    try {
      embeddingsApiKey = decrypt(row.embeddings_api_key)
    } catch {
      // Not silent — a rotated/mismatched ENCRYPTION_KEY here means
      // semantic search quietly stops working, so leave a breadcrumb.
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`,
      )
      embeddingsApiKey = null
    }
  }

  const config: AiConfig = {
    provider: row.provider,
    model: row.model,
    // When a chat connection is linked the legacy key is unused —
    // do NOT decrypt it (a corrupt/rotated ENCRYPTION_KEY remnant must
    // not take down an otherwise fully connection-driven config).
    apiKey: row.api_key && !hasChatLink ? decrypt(row.api_key) : null,
    systemPrompt: row.system_prompt,
    isActive: row.is_active,
    autoReplyEnabled: row.auto_reply_enabled,
    autoReplyMaxPerConversation: row.auto_reply_max_per_conversation,
    handoffAgentId: row.handoff_agent_id,
    embeddingsApiKey,
    chat: null,
    embeddingSetup: null,
  }

  // ------------------------------------------------------------
  // Connection path (flag-gated). Legacy columns above keep working
  // untouched for accounts that never linked a connection.
  // ------------------------------------------------------------
  if (multiProviderEnabled() && row.chat_connection_id) {
    const runtime = await loadRuntimeConnection(db, accountId, row.chat_connection_id)
    config.chat = {
      connectionId: runtime.id,
      protocol: runtime.protocol as AiConnectionProtocol,
      apiKey: runtime.apiKey,
      apiRoot: runtime.apiRoot.toString(),
      customEndpoint: runtime.customEndpoint,
      model: row.chat_model || row.model,
    }
  }
  if (
    multiProviderEnabled() &&
    row.embedding_connection_id &&
    row.embedding_model
  ) {
    config.embeddingSetup = {
      embeddingConnectionId: row.embedding_connection_id,
      embeddingModel: row.embedding_model,
      activeRevision: row.embedding_revision,
      pendingRevision: row.embedding_pending_revision,
      reindexState: row.embedding_reindex_state ?? 'pending',
    }
  }

  return config
}

/**
 * Load + decrypt just the embeddings key, independent of `is_active`.
 * Used by the knowledge-base ingest routes so the KB gets embedded (and
 * semantic search works) whenever an embeddings key is present, even if
 * the assistant's master switch is currently off.
 *
 * Returns `{ key, embedSetup, corrupt }`:
 *  • `key` — legacy BYO OpenAI embeddings key (null if unset).
 *  • `embedSetup` — the Phase 05 connection-based embedding config
 *    (null when not linked or the flag is off).
 *  • `corrupt` — distinguishes “missing key” from “key set but
 *    undecryptable” so callers can warn instead of silently falling
 *    back to lexical. Only applies to the legacy key path; a corrupt
 *    CONNECTION surfaces from loadRuntimeConnection as a thrown error.
 */
export async function loadEmbeddingsKey(
  db: SupabaseClient,
  accountId: string,
): Promise<{
  key: string | null
  corrupt: boolean
  embedSetup: EmbeddingSetup | null
}> {
  const { data, error } = await db
    .from('ai_configs')
    .select(
      'embeddings_api_key, embedding_connection_id, embedding_model, embedding_revision, embedding_pending_revision, embedding_reindex_state',
    )
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !data) return { key: null, corrupt: false, embedSetup: null }

  let embedSetup: EmbeddingSetup | null = null
  if (
    multiProviderEnabled() &&
    data.embedding_connection_id &&
    data.embedding_model
  ) {
    embedSetup = {
      embeddingConnectionId: data.embedding_connection_id,
      embeddingModel: data.embedding_model,
      activeRevision: data.embedding_revision ?? null,
      pendingRevision: data.embedding_pending_revision ?? null,
      reindexState: (data.embedding_reindex_state ?? 'pending') as EmbeddingSetup['reindexState'],
    }
  }

  if (!data.embeddings_api_key) return { key: null, corrupt: false, embedSetup }
  try {
    return { key: decrypt(data.embeddings_api_key), corrupt: false, embedSetup }
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`,
    )
    return { key: null, corrupt: true, embedSetup }
  }
}
