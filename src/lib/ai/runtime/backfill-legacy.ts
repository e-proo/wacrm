// Server-only by convention — see repositories.ts for the
// rationale on avoiding the `server-only` package.
import crypto from 'crypto'
import { supabaseAdmin } from '../admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { AiAgent, AiAgentRevision } from './multi-agent-types'

// ============================================================
// Backfill — ai_configs → multi-agent world (Phase 1).
//
// Idempotent. Designed to run once per account on first cutover
// and any number of times thereafter without duplicating work.
//
// What it does:
//   1. If the account already has a `customer_service` agent +
//      a published revision + a non-disabled provider connection
//      linked to `legacy_ai_config_id`, no-op and return
//      `{ skipped: true }`.
//   2. Otherwise, copy the BYO key from `ai_configs.api_key` into
//      a NEW `ai_provider_connections` row (Phase 05 already
//      provides the connections table — we only ADD the legacy
//      link column).
//      • The encrypted ciphertext is copied VERBATIM. We do not
//        re-encrypt — re-encrypting with a fresh IV would silently
//        invalidate the ciphertext under the existing
//        `ENCRYPTION_KEY`.
//      • Status is set to 'active' if the source config is
//        `is_active`, else 'unverified' (the admin can verify
//        later).
//   3. Create the `customer_service` system agent.
//   4. Create revision_number=1 as a draft, then publish it
//      atomically. The first revision copies:
//        • model
//        • system_prompt
//        • max_ai_replies_per_conversation
//        • handoff_human_member_id
//   5. Seed a `default` route for the customer-service agent.
//   6. Stamp `legacy_ai_config_id` on the connection so the next
//      run is a no-op.
//
// Backfill does NOT create the `admin_operations` agent — that
// only becomes active after the operator verifies an admin
// identity, which is a manual product decision.
// ============================================================

export interface BackfillResult {
  skipped: boolean
  reason?: string
  agent?: AiAgent
  revision?: AiAgentRevision
}

interface LegacyConfigRow {
  id: string
  account_id: string
  provider: 'openai' | 'anthropic'
  model: string
  api_key: string
  system_prompt: string | null
  is_active: boolean
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number
  handoff_agent_id: string | null
}

export async function backfillAccountFromLegacyConfig(
  accountId: string,
): Promise<BackfillResult> {
  const db = supabaseAdmin()

  const { data: legacy, error: legacyErr } = await db
    .from('ai_configs')
    .select(
      'id, account_id, provider, model, api_key, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id',
    )
    .eq('account_id', accountId)
    .maybeSingle()
  if (legacyErr) throw legacyErr
  if (!legacy) {
    return { skipped: true, reason: 'no_legacy_config' }
  }
  const legacyRow = legacy as LegacyConfigRow

  // Idempotency guard: did we already backfill this account?
  const { data: existingConn, error: connErr } = await db
    .from('ai_provider_connections')
    .select('id, status, legacy_ai_config_id')
    .eq('account_id', accountId)
    .eq('legacy_ai_config_id', legacyRow.id)
    .maybeSingle()
  if (connErr) throw connErr
  if (existingConn) {
    // Backfill already ran. Confirm the system agent exists.
    const { data: existingAgent } = await db
      .from('ai_agents')
      .select('id, published_revision_id')
      .eq('account_id', accountId)
      .eq('system_key', 'customer_service')
      .maybeSingle()
    if (
      existingAgent &&
      (existingAgent as { published_revision_id: string | null })
        .published_revision_id
    ) {
      return { skipped: true, reason: 'already_backfilled' }
    }
  }

  // 1) Create the provider connection (or reuse the one already
  //    linked to this legacy config, see the guard above).
  let connectionId: string
  if (existingConn) {
    connectionId = (existingConn as { id: string }).id
  } else {
    // Validate the ciphertext can be decrypted (we don't keep
    // the plaintext, but a corrupted key MUST fail loudly).
    try {
      decrypt(legacyRow.api_key)
    } catch {
      return {
        skipped: true,
        reason: 'legacy_key_undecryptable',
      }
    }
    const fingerprint = computeFingerprint(legacyRow.api_key)
    const { data: conn, error: insConn } = await db
      .from('ai_provider_connections')
      .insert({
        account_id: accountId,
        name: 'Migrated legacy key',
        preset_id: legacyRow.provider,
        protocol: legacyRow.provider,
        // Reuse the same API root as the existing adapter default.
        api_root: legacyRow.provider === 'openai'
          ? 'https://api.openai.com/v1'
          : 'https://api.anthropic.com',
        encrypted_api_key: legacyRow.api_key,
        connection_fingerprint: fingerprint,
        status: legacyRow.is_active ? 'active' : 'unverified',
        legacy_ai_config_id: legacyRow.id,
        // capabilities = {} — the runtime resolves model
        // capability at call-time from the adapter registry.
        capabilities: {},
      })
      .select('id')
      .single()
    if (insConn || !conn) {
      console.error('[backfill] connection insert failed:', insConn)
      return { skipped: true, reason: 'connection_insert_failed' }
    }
    connectionId = (conn as { id: string }).id
  }

  // 2) Create the customer_service system agent (or reuse).
  let agentId: string
  {
    const { data: existing } = await db
      .from('ai_agents')
      .select('id')
      .eq('account_id', accountId)
      .eq('system_key', 'customer_service')
      .maybeSingle()
    if (existing) {
      agentId = (existing as { id: string }).id
    } else {
      const { data: ins, error: insErr } = await db
        .from('ai_agents')
        .insert({
          account_id: accountId,
          system_key: 'customer_service',
          slug: 'customer-service',
          name: 'Customer Service',
          description: 'Migrated from the legacy AI configuration.',
          purpose: 'customer_support',
          status: 'draft',
        })
        .select('id')
        .single()
      if (insErr || !ins) {
        console.error('[backfill] agent insert failed:', insErr)
        return { skipped: true, reason: 'agent_insert_failed' }
      }
      agentId = (ins as { id: string }).id
    }
  }

  // 3) Create revision_number=1.
  const { data: rev, error: revErr } = await db
    .from('ai_agent_revisions')
    .insert({
      account_id: accountId,
      agent_id: agentId,
      revision_number: 1,
      status: 'draft',
      provider_connection_id: connectionId,
      model: legacyRow.model,
      system_prompt: legacyRow.system_prompt,
      response_style: 'balanced',
      language_policy: 'auto',
      max_tool_rounds: 0,
      max_ai_replies_per_conversation: legacyRow.auto_reply_max_per_conversation,
      handoff_human_member_id: legacyRow.handoff_agent_id,
      settings: { migrated_from: 'ai_configs', auto_reply_enabled: legacyRow.auto_reply_enabled },
    })
    .select(
      'id, account_id, agent_id, revision_number, status, provider_connection_id, model, system_prompt, response_style, language_policy, temperature, max_output_tokens, max_tool_rounds, max_ai_replies_per_conversation, handoff_human_member_id, settings, created_at, published_at, published_by, rejection_reason',
    )
    .single()
  if (revErr || !rev) {
    console.error('[backfill] revision insert failed:', revErr)
    return { skipped: true, reason: 'revision_insert_failed' }
  }
  const revision = rev as unknown as AiAgentRevision

  // 4) Publish the revision (atomic swap).
  //    We re-use the service here — keeps the publish logic in
  //    ONE place (agents-service.ts).
  const { publishAgentRevision } = await import('./agents-service')
  let publishedAgent: AiAgent
  try {
    publishedAgent = await publishAgentRevision(db, {
      accountId,
      agentId,
      revisionId: revision.id,
      actorUserId: null,
    })
  } catch (err) {
    console.error('[backfill] publish failed:', err)
    return { skipped: true, reason: 'publish_failed' }
  }

  // 5) Default route for the channel.
  const { data: existingDefault } = await db
    .from('ai_agent_routes')
    .select('id')
    .eq('account_id', accountId)
    .eq('route_kind', 'default')
    .eq('channel', 'whatsapp')
    .eq('is_active', true)
    .maybeSingle()
  if (!existingDefault) {
    await db.from('ai_agent_routes').insert({
      account_id: accountId,
      agent_id: agentId,
      name: 'Default WhatsApp route',
      channel: 'whatsapp',
      route_kind: 'default',
      priority: 50,
      is_active: true,
      conditions: {},
      stop_processing: true,
    })
  }

  return {
    skipped: false,
    agent: publishedAgent,
    revision,
  }
}

function computeFingerprint(ciphertext: string): string {
  // HMAC-SHA-256 over the ciphertext. We don't have the same
  // server-side HMAC key the connection-loader uses, so use the
  // project's ENCRYPTION_KEY as the HMAC key (acceptable: a
  // rotated ENCRYPTION_KEY already invalidates all ciphertexts).
  // The result is opaque and never returned to clients.
  const hmacKey = process.env.ENCRYPTION_KEY ?? 'fallback'
  return crypto.createHmac('sha256', hmacKey).update(ciphertext).digest('hex')
}
