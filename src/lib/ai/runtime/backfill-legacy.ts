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

  // ------------------------------------------------------------
  // Global idempotency guard — runs BEFORE the legacy-config
  // lookup so accounts that configured their provider through
  // the NEW connections UI (no ai_configs row) also get the
  // seeded agents, and so a completed backfill short-circuits.
  // ------------------------------------------------------------
  const { data: existingCsAgent } = await db
    .from('ai_agents')
    .select('id, published_revision_id')
    .eq('account_id', accountId)
    .eq('system_key', 'customer_service')
    .maybeSingle()
  if (
    existingCsAgent &&
    (existingCsAgent as { published_revision_id: string | null })
      .published_revision_id
  ) {
    return { skipped: true, reason: 'already_backfilled' }
  }

  const { data: legacy, error: legacyErr } = await db
    .from('ai_configs')
    .select(
      'id, account_id, provider, model, api_key, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id',
    )
    .eq('account_id', accountId)
    .maybeSingle()
  if (legacyErr) throw legacyErr

  // Fallback path: the account has NO legacy ai_configs row but
  // DOES have at least one provider connection created through
  // the connections UI (Phase 05). Seed the agents from that
  // connection instead of failing with no_legacy_config.
  if (!legacy) {
    return backfillFromExistingConnection(accountId, db)
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
    if (
      existingCsAgent &&
      (existingCsAgent as { published_revision_id: string | null })
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

// ============================================================
// backfillFromExistingConnection — seeds the two system agents
// for accounts that configured their provider through the NEW
// connections UI (Phase 05) and never had an `ai_configs` row.
//
// Unlike the legacy path, there's no ciphertext migration to
// do — the connection already works. We only need to:
//   1. Create/reuse the customer_service agent + revision 1
//      (model is a placeholder the admin edits in the UI, since
//      the UI-scoped connection carries its own model catalog).
//   2. Publish revision 1.
//   3. Create/reuse the admin_operations agent (draft, stays
//      paused until a trusted admin identity is verified).
//   4. Seed the default + admin routes.
// ============================================================
async function backfillFromExistingConnection(
  accountId: string,
  db: ReturnType<typeof supabaseAdmin>,
): Promise<BackfillResult> {
  // Pick the account's first usable connection (active or
  // verified, most recently created).
  const { data: conn, error: connErr } = await db
    .from('ai_provider_connections')
    .select('id, name, status, model')
    .eq('account_id', accountId)
    .in('status', ['active', 'verified'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (connErr) throw connErr
  if (!conn) {
    return { skipped: true, reason: 'no_usable_connection' }
  }
  const connectionId = (conn as { id: string }).id
  // The connections table may store the model inside `capabilities`
  // or a per-connection config; fall back to a safe placeholder
  // the admin can change from the agent detail screen.
  const fallbackModel =
    (conn as { model?: string | null }).model ?? 'gpt-4o-mini'

  // 1) Create/reuse the customer_service agent. The global
  //    idempotency guard above already returned early when a
  //    published customer_service agent exists, so reaching this
  //    point means the agent is missing OR still a draft — either
  //    way we can safely reuse it when present.
  const { data: csAgentRow } = await db
    .from('ai_agents')
    .select('id, published_revision_id')
    .eq('account_id', accountId)
    .eq('system_key', 'customer_service')
    .maybeSingle()
  let agentId: string
  if (csAgentRow) {
    agentId = (csAgentRow as { id: string }).id
  } else {
    const { data: ins, error: insErr } = await db
      .from('ai_agents')
      .insert({
        account_id: accountId,
        system_key: 'customer_service',
        slug: 'customer-service',
        name: 'Customer Service',
        description: 'Seeded during multi-agent onboarding.',
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

  // 2) Create revision 1 from the existing connection.
  const { data: rev, error: revErr } = await db
    .from('ai_agent_revisions')
    .insert({
      account_id: accountId,
      agent_id: agentId,
      revision_number: 1,
      status: 'draft',
      provider_connection_id: connectionId,
      model: fallbackModel,
      system_prompt: null,
      response_style: 'balanced',
      language_policy: 'auto',
      max_tool_rounds: 0,
      max_ai_replies_per_conversation: 3,
      handoff_human_member_id: null,
      settings: { seeded_from: 'existing_connection' },
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

  // 3) Publish atomically via the shared service.
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

  // 4) Default route for the customer agent.
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

  // 5) Create/reuse the admin_operations agent (stays draft —
  //    it activates after a trusted admin identity is verified).
  const { data: existingAdmin } = await db
    .from('ai_agents')
    .select('id')
    .eq('account_id', accountId)
    .eq('system_key', 'admin_operations')
    .maybeSingle()
  if (!existingAdmin) {
    const { data: adminIns, error: adminErr } = await db
      .from('ai_agents')
      .insert({
        account_id: accountId,
        system_key: 'admin_operations',
        slug: 'admin-operations',
        name: 'Admin Operations',
        description:
          'Handles administrative messages from verified admins.',
        purpose: 'admin_operations',
        status: 'draft',
      })
      .select('id')
      .single()
    if (adminErr || !adminIns) {
      console.error('[backfill] admin agent insert failed:', adminErr)
    } else {
      // 6) Admin plane route (router only fires it for verified
      //    identities, so seeding it now is safe).
      const { data: existingAdminRoute } = await db
        .from('ai_agent_routes')
        .select('id')
        .eq('account_id', accountId)
        .eq('route_kind', 'admin')
        .eq('channel', 'whatsapp')
        .maybeSingle()
      if (!existingAdminRoute) {
        await db.from('ai_agent_routes').insert({
          account_id: accountId,
          agent_id: (adminIns as { id: string }).id,
          name: 'Admin plane',
          channel: 'whatsapp',
          route_kind: 'admin',
          priority: 200,
          is_active: true,
          conditions: {},
          stop_processing: true,
        })
      }
    }
  }

  return {
    skipped: false,
    agent: publishedAgent,
    revision,
  }
}
