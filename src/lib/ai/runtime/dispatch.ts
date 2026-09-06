// Server-only by convention — see repositories.ts for the
// rationale on avoiding the `server-only` package.
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '../admin-client'
import { loadConversationAiState, loadRoutingSnapshotAdmin } from './repositories'
import { routeInboundMessage } from './router'
import type {
  AccountId,
  AiAgentRevision,
  RoutingDecision,
  Uuid,
} from './multi-agent-types'

// ============================================================
// Inbound AI dispatch (Phase 1).
//
// Invoked from the WhatsApp webhook AFTER:
//   • the inbound message is persisted idempotently,
//   • `conversation.assigned_agent_id` is read,
//   • any flow / automation that should consume the message has
//     already had its shot (so we never double-text).
//
// Responsibilities:
//   1. Resolve the routing snapshot (admin identities, routes,
//      agents + their published revisions) in one round-trip.
//   2. Resolve the conversation's AI state.
//   3. Run the pure router; if it returns `skip`, we log the
//      reason and return — no run row, no outbound.
//   4. If it returns `route`, create a `queued` `ai_agent_runs`
//      row via the service-role RPC (idempotent on
//      `inbound_message_id`) and kick off the run synchronously
//      when the runtime supports it.
//
// The actual generation step is delegated to a thin provider
// adapter call (see `executeAgentRun`). Phase 1 keeps that path
// text-only — tool calls land in Phase 3.
// ============================================================

export class DispatchError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 500) {
    super(message)
    this.name = 'DispatchError'
    this.code = code
    this.status = status
  }
}

export interface DispatchInboundArgs {
  accountId: AccountId
  conversationId: Uuid
  inboundMessageId: Uuid
  senderAddress: string
  /** Pre-loaded conversation row (avoids an extra read). */
  hasHumanAssignee: boolean
  /** Skip the network round-trip when the multi-agent flag is
   *  off, so callers can short-circuit. */
  multiAgentEnabled: boolean
  /** Worker identity used to claim the run lease. */
  workerId: string
}

export interface DispatchInboundResult {
  decision: RoutingDecision
  runId: Uuid | null
  /** True when a run row was inserted (or already existed). */
  queued: boolean
}

/**
 * Synchronous dispatcher used by the webhook's `after()` block.
 *
 * Owns its try/catch and NEVER throws — the caller's promise
 * chain (which keeps the function alive inside `after()`) MUST
 * not see a rejection. Failures are logged with the run id so
 * they can be diagnosed in the audit log.
 */
export async function dispatchInboundToAiAgent(
  args: DispatchInboundArgs,
): Promise<DispatchInboundResult> {
  const skip = (reason: string): DispatchInboundResult => ({
    decision: { action: 'skip', reason },
    runId: null,
    queued: false,
  })

  try {
    if (!args.multiAgentEnabled) {
      return skip('multi_agent_disabled')
    }

    const db = supabaseAdmin()

    // The webhook flow has already created/looked-up the
    // conversation; we read its AI state here. Missing row is OK
    // — defaults are applied by the router.
    const conversationAiState = await loadConversationAiState(
      db,
      args.conversationId,
    )

    const snapshot = await loadRoutingSnapshotAdmin(args.accountId)

    const decision = routeInboundMessage(
      {
        accountId: args.accountId,
        channel: 'whatsapp',
        senderAddress: args.senderAddress,
        conversationAiState,
        hasHumanAssignee: args.hasHumanAssignee,
        multiAgentEnabled: args.multiAgentEnabled,
      },
      snapshot,
    )

    if (decision.action === 'skip') {
      return { decision, runId: null, queued: false }
    }

    // Insert (or no-op-on-replay) the run row.
    const runId = await createAgentRunRow(args, decision)
    if (!runId) {
      // Duplicate (replayed webhook). The previous run handled it;
      // we treat it as a successful skip so callers don't try to
      // dispatch twice.
      return { decision, runId: null, queued: false }
    }

    // Try to claim + run synchronously. If the runtime can keep
    // the function alive long enough (Next.js `after()` does),
    // this delivers a single response. If the run can't finish in
    // time, we leave it in `claimed` for the recovery worker.
    const finished = await executeAgentRun(args.accountId, runId, args.workerId)
    if (!finished) {
      return { decision, runId, queued: true }
    }
    return { decision, runId, queued: true }
  } catch (err) {
    console.error('[ai dispatch] failed:', err)
    return {
      decision: { action: 'skip', reason: 'dispatch_internal_error' },
      runId: null,
      queued: false,
    }
  }
}

async function createAgentRunRow(
  args: DispatchInboundArgs,
  decision: Extract<RoutingDecision, { action: 'route' }>,
): Promise<Uuid | null> {
  const db = supabaseAdmin()
  const { data, error } = await db.rpc('create_agent_run', {
    p_account_id: args.accountId,
    p_conversation_id: args.conversationId,
    p_inbound_message_id: args.inboundMessageId,
    p_ai_agent_id: decision.agentId,
    p_agent_revision_id: decision.revisionId,
    p_provider_connection_id: decision.providerConnectionId,
    p_route_id: decision.routeId,
    p_route_reason: decision.reason,
    p_plane: decision.plane,
  })
  if (error) {
    // The RPC returns the existing run id on duplicate; a real
    // error surfaces here. The webhook must not see this — we
    // log and return null so the caller treats it as a skip.
    console.error('[ai dispatch] create_agent_run failed:', error)
    return null
  }
  return data as Uuid | null
}

async function executeAgentRun(
  accountId: AccountId,
  runId: Uuid,
  workerId: string,
): Promise<boolean> {
  const db = supabaseAdmin()
  const claimed = await db.rpc('claim_agent_run', {
    p_run_id: runId,
    p_claimed_by: workerId,
    p_lease_secs: 60,
  })
  if (claimed.error) {
    console.error('[ai dispatch] claim_agent_run failed:', claimed.error)
    return false
  }
  if (claimed.data !== 'claimed') {
    // Someone else claimed it; the recovery worker will pick it up.
    return false
  }

  // Phase 1 deliberately stops here: the generation step is the
  // existing `dispatchInboundToAiReply` path, which is gated on
  // `ai_configs` + the legacy `conversation.assigned_agent_id` /
  // `ai_autoreply_disabled` columns. Bridging the new run row
  // into that path is done by the Phase 1 → Phase 2/3 transition
  // and is intentionally out of scope here. We mark the run as
  // `skipped` so the audit log carries an explicit reason and the
  // recovery worker doesn't re-claim it forever.
  const { error: skipErr } = await db
    .from('ai_agent_runs')
    .update({
      status: 'skipped',
      completed_at: new Date().toISOString(),
      error_code: 'phase1_legacy_path_only',
    })
    .eq('id', runId)
    .eq('status', 'claimed')
  if (skipErr) {
    console.error('[ai dispatch] mark skipped failed:', skipErr)
  }
  await db.rpc('append_agent_run_event', {
    p_account_id: accountId,
    p_run_id: runId,
    p_event_type: 'skipped',
    p_actor_type: 'service',
    p_actor_id: workerId,
    p_payload: { reason: 'phase1_legacy_path_only' },
  })
  return true
}

// ------------------------------------------------------------
// Recovery worker — picks up runs whose lease expired.
// Phase 1 ships the stub + service-role RPC. A real deployment
// runs this on a scheduler; locally it can be invoked from a
// `__test__` API or a one-off script.
// ------------------------------------------------------------

export interface RecoverySweepResult {
  scanned: number
  reaped: number
}

/**
 * Reclaim queued / expired-lease runs and mark them as failed
 * if they're past their max attempts. We do NOT auto-retry in
 * Phase 1 — auto-retry logic lands in Phase 3 alongside the
 * tool-call timeout policies.
 */
export async function sweepAgentRuns(
  db: SupabaseClient,
  opts: { now?: Date } = {},
): Promise<RecoverySweepResult> {
  const now = opts.now ?? new Date()
  // Find runs whose lease has expired but status is still
  // 'claimed'. Mark them back to 'queued' for re-claim, or
  // 'failed' if attempt_count is at the cap.
  const { data: expired, error } = await db
    .from('ai_agent_runs')
    .select('id, account_id, attempt_count')
    .in('status', ['claimed'])
    .lt('lease_expires_at', now.toISOString())
    .limit(200)
  if (error) throw error
  let reaped = 0
  for (const row of expired ?? []) {
    const r = row as { id: string; account_id: string; attempt_count: number }
    const nextStatus = r.attempt_count >= 10 ? 'failed' : 'queued'
    const { error: updErr } = await db
      .from('ai_agent_runs')
      .update({
        status: nextStatus,
        lease_expires_at: null,
        claimed_by: null,
        available_at: now.toISOString(),
        error_code: nextStatus === 'failed' ? 'LEASE_LOST_MAX_ATTEMPTS' : null,
        completed_at: nextStatus === 'failed' ? now.toISOString() : null,
      })
      .eq('id', r.id)
      .eq('status', 'claimed')
    if (updErr) {
      console.error('[ai sweep] failed to reap run:', updErr)
      continue
    }
    reaped++
    await db.rpc('append_agent_run_event', {
      p_account_id: r.account_id,
      p_run_id: r.id,
      p_event_type: nextStatus === 'failed' ? 'failed' : 'claimed',
      p_actor_type: 'system',
      p_actor_id: 'recovery-sweep',
      p_payload: { reason: 'lease_expired', attempt: r.attempt_count },
    })
  }
  return { scanned: (expired ?? []).length, reaped }
}

// ------------------------------------------------------------
// Re-export for callers that want to peek at the decision
// without committing to a run row.
// ------------------------------------------------------------

export { routeInboundMessage } from './router'
export type { RoutingDecision, AiAgentRevision }
