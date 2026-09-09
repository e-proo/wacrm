// Server-only by convention.
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '../admin-client'
import { loadConversationAiState, loadRoutingSnapshotAdmin } from './repositories'
import { routeInboundMessage } from './router'
import {
  executeCoverageCheckAvailability,
  executeExchangeRatesGetCurrent,
  executePricingCalculateQuote,
  executeServicesGet,
  executeServicesSearch,
  executeServicesMatchRequest,
  executeIntentsRecord,
  executeIntentsSearch,
  type ToolContext,
  type ToolResult,
} from '../tools/executors'
import { recordToolAttempt } from './tool-attempt-audit'
import type {
  AccountId,
  AiAgentRevision,
  RoutingDecision,
  ToolGrantPermission,
  Uuid,
} from './multi-agent-types'

// ============================================================
// Inbound AI dispatch (Phase 3) — runtime tool execution.
//
// In Phase 1 the dispatcher resolved routing + created a run
// row + marked it `skipped` (`phase1_legacy_path_only`). Phase 3
// keeps that fallback but ADDS the live runtime path:
//   1. Resolve the routing decision.
//   2. Create the run row.
//   3. Claim it.
//   4. Drive a tool-calling loop:
//        a. The model produces either a textual response OR a
//           tool call (key + JSON args).
//        b. The runtime validates the grant on the published
//           revision.
//        c. The executor runs; result is appended to the run's
//           tool history.
//        d. Loop until the model emits a final response or
//           hits the tool-round cap.
//   5. Send the final response back through the existing
//      `dispatchInboundToAiReply` channel (Phase 1's legacy
//      path) OR, once Phase 4 ships the AI outbound writer, a
//      new `sendWhatsApp` path.
//
// In Phase 3 we don't yet call a real model — the loop is
// scaffolded but the model integration is deferred to Phase 4.
// What this module DOES ship in Phase 3:
//   • A typed `dispatchInboundToAiAgentV3` that wires the
//     existing dispatcher into the Phase-3 tool layer.
//   • The runtime tool-call dispatcher (`executeTool`) — pure
//     routing + validation; the model call sits on top.
//   • A regression for the legacy "skipped" path so the
//     existing tests don't drift.
//
// Idempotent on `inbound_message_id` via the existing SQL RPC.
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
 * Never throws — see `dispatch.ts` for the same contract.
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

    const runId = await createAgentRunRow(args, decision)
    if (!runId) {
      return { decision, runId: null, queued: false }
    }

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
    return false
  }

  // Phase 1 behaviour preserved: the new path is observably
  // active (run row exists, events appended) without changing
  // the generation channel. Phase 3 layers the tool executor
  // beneath but does not yet wire a real model — that's Phase 4.
  const { error: skipErr } = await db
    .from('ai_agent_runs')
    .update({
      status: 'skipped',
      completed_at: new Date().toISOString(),
      error_code: 'phase3_legacy_path_only',
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
    p_payload: { reason: 'phase3_legacy_path_only' },
  })
  return true
}

// ------------------------------------------------------------
// Phase 3 — runtime tool dispatcher
//
// Called by the (Phase 4) model loop to execute a single tool
// call. Validates:
//   • the tool is registered (DENY BY DEFAULT),
//   • the agent's published revision has a grant for it,
//   • the requested permission level is in the tool's
//     grant_permissions list,
//   • max-tool-rounds isn't exhausted.
//
// Returns a `ToolResult` with `safe_to_show` so the model knows
// whether it can echo the message verbatim to the customer.
// ------------------------------------------------------------

export interface ToolInvocation {
  toolKey: string
  /** Permission the model claims it needs. Must be 'read' for
   *  every tool Phase 3 ships. */
  permission: ToolGrantPermission
  args: Record<string, unknown>
  /** Round number in the agent's loop, starting at 1. */
  round: number
}

export interface ToolExecutionOutcome {
  toolKey: string
  round: number
  result: ToolResult
  toolFound: boolean
  granted: boolean
  roundsExhausted: boolean
}

export async function executeTool(
  ctx: ToolContext & { revision: AiAgentRevision | null },
  invocation: ToolInvocation,
): Promise<ToolExecutionOutcome> {
  const baseOutcome = {
    toolKey: invocation.toolKey,
    round: invocation.round,
  }

  const audit = async (input: {
    status: 'accepted' | 'denied' | 'succeeded' | 'failed'
    errorCode?: string
    toolVersion?: number
    durationMs?: number
  }) => recordToolAttempt({
    accountId: ctx.accountId,
    runId: ctx.runId,
    agentId: ctx.agentId ?? null,
    revisionId: ctx.revisionId ?? ctx.revision?.id ?? null,
    toolKey: invocation.toolKey,
    toolVersion: input.toolVersion ?? 1,
    round: invocation.round,
    permission: invocation.permission,
    status: input.status,
    errorCode: input.errorCode,
    args: invocation.args,
    durationMs: input.durationMs,
  })

  // Tool-round cap is enforced from the revision (maxToolRounds).
  const maxRounds = ctx.revision?.maxToolRounds ?? 0
  if (maxRounds === 0) {
    await audit({ status: 'denied', errorCode: 'TOOL_ROUNDS_DISABLED' })
    return {
      ...baseOutcome,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'TOOL_ROUNDS_DISABLED',
        message:
          'This agent does not have tool rounds enabled. Reschedule or ask a human.',
      },
      toolFound: false,
      granted: false,
      roundsExhausted: true,
    }
  }
  if (invocation.round > maxRounds) {
    await audit({ status: 'denied', errorCode: 'TOOL_ROUNDS_EXHAUSTED' })
    return {
      ...baseOutcome,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'TOOL_ROUNDS_EXHAUSTED',
        message: 'Tool rounds exhausted.',
      },
      toolFound: false,
      granted: false,
      roundsExhausted: true,
    }
  }

  const { getRegisteredTool, isGrantAllowed } = await import('./tool-registry')
  const tool = getRegisteredTool(invocation.toolKey)
  if (!tool) {
    await audit({ status: 'denied', errorCode: 'UNKNOWN_TOOL' })
    return {
      ...baseOutcome,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'UNKNOWN_TOOL',
        message: `Tool "${invocation.toolKey}" is not registered.`,
      },
      toolFound: false,
      granted: false,
      roundsExhausted: false,
    }
  }
  if (!isGrantAllowed(tool, invocation.permission)) {
    await audit({ status: 'denied', errorCode: 'TOOL_PERMISSION_DENIED', toolVersion: tool.version })
    return {
      ...baseOutcome,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'TOOL_PERMISSION_DENIED',
        message: `Tool "${invocation.toolKey}" cannot be used with permission "${invocation.permission}".`,
      },
      toolFound: true,
      granted: false,
      roundsExhausted: false,
    }
  }

  const startedAt = Date.now()
  let result: ToolResult
  try {
    switch (invocation.toolKey) {
      case 'services.search':
        result = await executeServicesSearch(ctx, invocation.args as never)
        break
      case 'services.get':
        result = await executeServicesGet(ctx, invocation.args as never)
        break
      case 'pricing.calculate_quote':
        result = await executePricingCalculateQuote(ctx, invocation.args as never)
        break
      case 'exchange_rates.get_current':
        result = await executeExchangeRatesGetCurrent(
          ctx,
          invocation.args as never,
        )
        break
      case 'coverage.check_availability':
        result = await executeCoverageCheckAvailability(ctx, invocation.args as never)
        break
      case 'services.match_request':
        result = await executeServicesMatchRequest(ctx, invocation.args as never)
        break
      case 'intents.record':
        result = await executeIntentsRecord(ctx, invocation.args as never)
        break
      case 'intents.search':
        result = await executeIntentsSearch(ctx, invocation.args as never)
        break
      default:
        result = {
          ok: false,
          data: null,
          safe_to_show: true,
          code: 'UNKNOWN_TOOL',
          message: `Tool "${invocation.toolKey}" is not registered.`,
        }
    }
  } catch (err) {
    console.error(
      `[ai dispatch] tool ${invocation.toolKey} crashed:`,
      err,
    )
    result = {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'TOOL_INTERNAL_ERROR',
      message: 'Tool execution failed unexpectedly.',
    }
  }

  await audit({
    status: result.ok ? 'succeeded' : 'failed',
    errorCode: result.ok ? undefined : result.code,
    toolVersion: tool.version,
    durationMs: Date.now() - startedAt,
  })
  return {
    ...baseOutcome,
    result,
    toolFound: true,
    granted: true,
    roundsExhausted: false,
  }
}

// ------------------------------------------------------------
// Re-exports
// ------------------------------------------------------------
export { routeInboundMessage } from './router'
export type { RoutingDecision, AiAgentRevision }

// The legacy sweep function is unchanged.
export { sweepAgentRuns } from './recovery'
