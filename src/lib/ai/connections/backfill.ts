import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { devFingerprint } from './service'
import { computeEmbeddingRevision } from './embed'
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from '../embeddings'
import type { AiProvider } from '../types'

// ============================================================
// Idempotent backfill: migrate legacy `ai_configs` rows into
// `ai_provider_connections` under the feature flag, without
// disabling or reading secrets aloud.
//
// Each legacy config produces one Chat connection (using its
// provider key) and, when `embeddings_api_key` is present and for a
// *different* purpose, a separate Embeddings connection. Today that
// only applies to Anthropic (which has no embeddings endpoint) when
// the account also set an embeddings key — in that case Chat uses
// Anthropic and Embeddings uses OpenAI.
//
// Idempotent by upsert on a deterministic key: the connection is
// looked up by (account_id, preset_id) and re-created if missing,
// but never duplicated. Running twice never creates a second row.
// ============================================================

interface LegacyConfigRow {
  id: string
  account_id: string
  provider: AiProvider
  model: string
  api_key: string // encrypted
  system_prompt: string | null
  is_active: boolean
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number
  handoff_agent_id: string | null
  embeddings_api_key: string | null // encrypted
  embeddings_model?: string | null
  embedding_connection_id?: string | null
}

interface BackfillResult {
  upserted: number
  skipped: number
  corrupt: number
  linked: number
  detail: Array<{
    account_id: string
    preset_id: string
    kind: 'chat' | 'embedding' | 'link'
    action: 'created' | 'exists' | 'corrupt' | 'linked' | 'already'
  }>
}

/**
 * Resolve a legacy `provider` value to the matching preset id.
 * OpenAI → openai, Anthropic → anthropic.
 */
function providerToPreset(provider: AiProvider): string {
  return provider // 1:1 today
}

/**
 * Decide whether the embeddings key on a legacy config is worth its
 * own connection. Today: always (it is OpenAI-compatible), but if
 * the chat key IS the embeddings key we reuse one connection.
 */
function shouldCreateEmbeddingsConnection(row: LegacyConfigRow): boolean {
  return !!row.embeddings_api_key && row.embeddings_api_key !== row.api_key
}

const CONN_COLUMNS =
  'id, account_id, preset_id, api_root'

/**
 * Run the backfill across all accounts that have a legacy
 * `ai_configs` row but no matching `ai_provider_connections` entry.
 *
 * `db` must be the service-role client (reads every account's legacy
 * config). Idempotent: re-running is a no-op beyond refreshing
 * `updated_at`. Never throws on a single account failure — records it
 * in `detail` and continues so one bad row can't abort the batch.
 */
export async function backfillProviderConnections(
  db: SupabaseClient,
): Promise<BackfillResult> {
  const result: BackfillResult = {
    upserted: 0,
    skipped: 0,
    corrupt: 0,
    linked: 0,
    detail: [],
  }

  const { data: legacyRows, error: loadErr } = await db
    .from('ai_configs')
    .select(
      'id, account_id, provider, model, api_key, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, embeddings_api_key, embeddings_model, embedding_connection_id',
    )

  if (loadErr) throw loadErr
  const rows = (legacyRows ?? []) as LegacyConfigRow[]

  for (const row of rows) {
    // --- Chat connection ---
    let chatConnId: string | null = null
    try {
      const presetId = providerToPreset(row.provider as AiProvider)
      chatConnId = await upsertConnection(db, row.account_id, presetId, row.api_key, row, 'chat', result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.corrupt += 1
      result.detail.push({
        account_id: row.account_id,
        preset_id: '-',
        kind: 'chat',
        action: 'corrupt',
      })
      console.error(`[backfill] chat key corrupt for account ${row.account_id}: ${msg}`)
    }

    // --- Embedding connection (separate key only) ---
    let embedConnId: string | null = chatConnId
    if (shouldCreateEmbeddingsConnection(row)) {
      try {
        // Embeddings are always OpenAI-compatible today.
        embedConnId = await upsertConnection(db, row.account_id, 'openai', row.embeddings_api_key!, row, 'embedding', result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        result.corrupt += 1
        result.detail.push({
          account_id: row.account_id,
          preset_id: 'openai',
          kind: 'embedding',
          action: 'corrupt',
        })
        console.error(`[backfill] embed key corrupt for account ${row.account_id}: ${msg}`)
        embedConnId = null
      }
    }

    // --- Link the embeddings config (idempotent, never re-prompts) ---
    if (row.embeddings_api_key) {
      try {
        await linkEmbeddingConfig(db, row, embedConnId, result)
      } catch (err) {
        console.error(
          `[backfill] embed link failed for account ${row.account_id}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  return result
}

/**
 * Point ai_configs at the backfilled embeddings connection WITHOUT
 * requiring key re-entry. Only runs when nothing is linked yet and
 * leaves semantic search running through the legacy key path
 * (`semanticQueryMode` falls back to the key until the pending
 * revision activates) — a queued-but-unrun re-index can never break
 * the live space. The legacy `embeddings_api_key` column is NOT
 * cleared (retirement belongs to the Phase 06 contract).
 */
async function linkEmbeddingConfig(
  db: SupabaseClient,
  row: LegacyConfigRow,
  embeddingConnectionId: string | null,
  result: BackfillResult,
): Promise<void> {
  if (row.embedding_connection_id) {
    result.detail.push({ account_id: row.account_id, preset_id: '-', kind: 'link', action: 'already' })
    return
  }
  if (!embeddingConnectionId) return // keys corrupt → nothing to link
  // A same-key account that chats on Anthropic has no embeddable
  // connection (Anthropic offers no embeddings API) — skip silently;
  // the legacy key path keeps working. Any other linked connection is
  // OpenAI-compatible (embeddings keys were validated against that
  // endpoint historically, so a stored one is OpenAI by definition).
  const reusesChat = !shouldCreateEmbeddingsConnection(row)
  if (reusesChat && row.provider === 'anthropic') {
    result.detail.push({ account_id: row.account_id, preset_id: 'anthropic', kind: 'link', action: 'already' })
    return
  }
  const protocol = 'openai'
  const pending = computeEmbeddingRevision({
    protocol,
    connectionId: embeddingConnectionId,
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
  })
  const { error } = await db
    .from('ai_configs')
    .update({
      embedding_connection_id: embeddingConnectionId,
      embedding_model: EMBEDDING_MODEL,
      embedding_dimensions: EMBEDDING_DIMENSIONS,
      embedding_pending_revision: pending,
      embedding_reindex_state: 'pending',
    })
    .eq('id', row.id)
    .is('embedding_connection_id', null) // second-run guard at SQL level
  if (error) throw error
  result.linked += 1
  result.detail.push({ account_id: row.account_id, preset_id: protocol, kind: 'link', action: 'linked' })
}

async function upsertConnection(
  db: SupabaseClient,
  accountId: string,
  presetId: string,
  encryptedKey: string,
  legacy: LegacyConfigRow,
  kind: 'chat' | 'embedding',
  result: BackfillResult,
): Promise<string | null> {
  const connName = kind === 'chat' ? 'Assistant (Chat)' : 'Assistant (Embeddings)'

  const { data: existing, error: existingErr } = await db
    .from('ai_provider_connections')
    .select(CONN_COLUMNS)
    .eq('account_id', accountId)
    .eq('name', connName)
    .maybeSingle()

  if (existingErr) throw existingErr

  // Reuse legacy ciphertext directly when its format is compatible
  // (GCM). For legacy CBC rows, decrypt-then-re-encrypt so new
  // connections always use the authenticated format. Either way the
  // plaintext never leaves this function or touches a log.
  let apiRoot: string
  let storedKey: string
  if (presetId === 'anthropic') {
    apiRoot = 'https://api.anthropic.com/v1/'
  } else {
    apiRoot = 'https://api.openai.com/v1/'
  }

  if (isLegacyFormat(encryptedKey)) {
    // legacy CBC row — refresh to GCM under a service-role transaction
    let plaintext: string
    try {
      plaintext = decrypt(encryptedKey)
    } catch {
      throw new Error('legacy key could not be decrypted')
    }
    storedKey = encrypt(plaintext)
  } else {
    storedKey = encryptedKey // already GCM; reuse directly
  }

  const fingerprint = devFingerprint()

  // The Chat connection inherits the legacy row's verified state
  // (it had to pass validateAiCredentials before being saved).
  const status = 'verified' as const
  const verifiedAt = legacy.is_active ? new Date().toISOString() : null

  if (existing) {
    result.skipped += 1
    result.detail.push({
      account_id: accountId,
      preset_id: presetId,
      kind,
      action: 'exists',
    })
    return (existing as { id: string }).id
  }

  const { data: inserted, error: insErr } = await db
    .from('ai_provider_connections')
    .insert({
      account_id: accountId,
      name: connName,
      preset_id: presetId,
      protocol: presetId === 'anthropic' ? 'anthropic' : 'openai',
      api_root: apiRoot,
      encrypted_api_key: storedKey,
      connection_fingerprint: fingerprint,
      status,
      verified_at: verifiedAt,
    })
    .select('id')
    .single()

  if (insErr) {
    // Unique violation on (account_id, name) → treat as already-exists.
    if (insErr.code === '23505') {
      result.skipped += 1
      result.detail.push({
        account_id: accountId,
        preset_id: presetId,
        kind,
        action: 'exists',
      })
      return null // caller re-runs to resolve; rare race, safe to defer
    }
    throw insErr
  }

  result.upserted += 1
  result.detail.push({
    account_id: accountId,
    preset_id: presetId,
    kind,
    action: 'created',
  })
  return (inserted as { id: string } | null)?.id ?? null
}

export { backfillProviderConnections as _backfill }
