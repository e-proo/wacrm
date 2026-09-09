// Server-only by convention.
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '../admin-client'
import { loadConversationAiState, loadRoutingSnapshotAdmin } from './repositories'
import { routeInboundMessage } from './router'
import { runAgentLoop } from './agent-loop'
import { engineSendText } from '@/lib/automations/meta-send'
import type { ChatMessage } from '../types'
import {
  executeCoverageCheckAvailability,
  executeExchangeRatesGetCurrent,
  executePricingCalculateQuote,
  executeServicesGet,
  executeServicesSearch,
  executeServicesMatchRequest,
  executeIntentsRecord,
  executeIntentsSearch,
  executeCoverageFindOffers,
  executeCoverageProposeOffer,
  type ToolContext,
  type ToolResult,
} from '../tools/executors'
import { recordToolAttempt } from './tool-attempt-audit'
import type {
  AccountId,
  AiAgentRevision,
  RoutingDecision,
  RoutingSnapshot,
  ToolGrantPermission,
  Uuid,
} from './multi-agent-types'

// ============================================================
// Inbound AI dispatch — LIVE model + tool-calling loop.
//
//   1. Resolve the routing decision (admin plane first).
//   2. Create the run row (idempotent on inbound_message_id).
//   3. Claim it (lease).
//   4. Run the real agent loop: model → tool call (validated) →
//      observation → … → final text, bounded by the revision's
//      max_tool_rounds.
//   5. Send the final text via the existing engineSendText channel
//      (idempotent per-run key) or hand off to a human on demand.
//
// Failure policy: provider/tool errors degrade to a safe fallback
// text or handoff — never a hallucinated answer, never a throw
// into the webhook chain.
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

// ------------------------------------------------------------
// Pre-check gate: decides BEFORE any generation which path owns
// the message. Called by the webhook instead of firing both the
// legacy auto-reply AND the agent loop (which would double-reply
// or double-bill). Fail-safe: any error here returns false so
// the battle-tested legacy path keeps serving customers.
// ------------------------------------------------------------
export interface MultiAgentPreCheckArgs {
  accountId: AccountId
  conversationId: Uuid
  senderAddress: string
  hasHumanAssignee: boolean
}

export async function shouldRouteToMultiAgent(
  args: MultiAgentPreCheckArgs,
): Promise<boolean> {
  try {
    const db = supabaseAdmin()
    const [conversationAiState, snapshot] = await Promise.all([
      loadConversationAiState(db, args.conversationId),
      loadRoutingSnapshotAdmin(args.accountId),
    ])
    const decision = routeInboundMessage(
      {
        accountId: args.accountId,
        channel: 'whatsapp',
        senderAddress: args.senderAddress,
        conversationAiState,
        hasHumanAssignee: args.hasHumanAssignee,
        multiAgentEnabled: true,
      },
      snapshot,
    )
    return decision.action === 'route'
  } catch (err) {
    console.error('[ai dispatch] pre-check failed, falling back to legacy:', err)
    return false
  }
}

export interface DispatchInboundArgs {
  accountId: AccountId
  conversationId: Uuid
  inboundMessageId: Uuid
  /** Contact UUID of the sender (for context + loop). */
  contactId: Uuid | null
  /** Owner of the WhatsApp config — audit identity for the send. */
  configOwnerUserId: string | null
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

    const finished = await executeAgentRun(
      args,
      runId,
      decision,
      snapshot,
      args.workerId,
    )
    if (finished === 'lost') {
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
  args: DispatchInboundArgs,
  runId: Uuid,
  decision: Extract<RoutingDecision, { action: 'route' }>,
  snapshot: RoutingSnapshot,
  workerId: string,
): Promise<'succeeded' | 'handoff' | 'failed' | 'lost'> {
  const db = supabaseAdmin()
  const claimed = await db.rpc('claim_agent_run', {
    p_run_id: runId,
    p_claimed_by: workerId,
    p_lease_secs: 60,
  })
  if (claimed.error) {
    console.error('[ai dispatch] claim_agent_run failed:', claimed.error)
    return 'lost'
  }
  if (claimed.data !== 'claimed') {
    console.info('[ai dispatch] claim lost (another worker?) run=' + runId.slice(0, 8))
    return 'lost'
  }
  console.info('[ai dispatch] claimed run=' + runId.slice(0, 8))

  // Load the frozen revision snapshot for this run. No join: the
  // purpose comes from the routing snapshot via the caller (the two
  // tables share TWO FKs, so an embedded ai_agents(...) is ambiguous
  // to PostgREST — PGRST201).
  const { data: revision, error: revErr } = await db
    .from('ai_agent_revisions')
    .select(
      'id, agent_id, status, model, system_prompt, response_style, language_policy, max_tool_rounds, max_ai_replies_per_conversation',
    )
    .eq('id', decision.revisionId)
    .maybeSingle()
  if (revErr || !revision) {
    console.error('[ai dispatch] revision load failed:', revErr)
    await markRun(db, args.accountId, runId, 'failed', 'REVISION_NOT_FOUND')
    return 'failed'
  }
  const rev = revision as unknown as AiAgentRevision
  console.info(
    `[ai dispatch] revision=${rev.id.slice(0, 8)} model=${rev.model} rounds=${rev.maxToolRounds} prompt=${rev.systemPrompt ? rev.systemPrompt.length + 'ch' : 'empty'}`,
  )

  // Conversation history for grounding. NOTE the real column
  // names: sender_type ('customer'|'agent'|'bot') and content_text
  // — NOT role/content. bot+agent senders map to 'assistant'.
  const { data: convMsgs, error: msgErr } = await db
    .from('messages')
    .select('sender_type, content_text, created_at')
    .eq('conversation_id', args.conversationId)
    .order('created_at', { ascending: true })
  if (msgErr) {
    console.error('[ai dispatch] messages load failed:', msgErr)
    await markRun(db, args.accountId, runId, 'failed', 'MESSAGES_LOAD_FAILED')
    return 'failed'
  }
  const history: ChatMessage[] = (convMsgs ?? [])
    .slice(-20)
    .map((m) => {
      const r = m as { sender_type: string; content_text: string | null }
      return {
        role: (r.sender_type === 'customer' ? 'user' : 'assistant') as ChatMessage['role'],
        content: String(r.content_text ?? ''),
      }
    })
    .filter((m) => m.content.trim().length > 0)
  console.info(
    `[ai dispatch] history=${history.length} msgs, purpose=${snapshot.agents.find((entry: { agent: { id: string; purpose: string } }) => entry.agent.id === decision.agentId)?.agent.purpose ?? 'custom'}`,
  )

  // The send needs an audit identity — fail BEFORE claiming a
  // reply slot or marking succeeded.
  if (!args.configOwnerUserId) {
    console.error('[ai dispatch] no configOwnerUserId — cannot send')
    await markRun(db, args.accountId, runId, 'failed', 'NO_CONFIG_OWNER')
    return 'failed'
  }

  // Per-conversation reply cap — same atomic slot claim the legacy
  // path uses, so both paths share one budget per thread.
  const { data: slot, error: slotErr } = await db.rpc('claim_ai_reply_slot', {
    conversation_id: args.conversationId,
    max_replies: rev.maxAiRepliesPerConversation ?? 3,
  })
  if (slotErr) {
    console.error('[ai dispatch] claim_ai_reply_slot failed:', slotErr)
    await markRun(db, args.accountId, runId, 'failed', 'SLOT_CLAIM_FAILED')
    return 'failed'
  }
  if (slot !== true) {
    console.info('[ai dispatch] reply slot lost/cap reached run=' + runId.slice(0, 8))
    await markRun(db, args.accountId, runId, 'failed', 'REPLY_SLOT_LOST')
    return 'failed'
  }

  const loop = await runAgentLoop({
    accountId: args.accountId,
    runId,
    agentId: decision.agentId,
    agentPurpose:
      snapshot.agents.find((entry: { agent: { id: string; purpose: string } }) => entry.agent.id === decision.agentId)?.agent
        .purpose ?? 'custom',
    revision: rev,
    messages: history,
    contactId: args.contactId,
  })
  console.info(
    `[ai dispatch] loop=${loop.status} tools=${loop.toolCalls.length} text=${loop.text ? loop.text.length + 'ch' : 'null'}`,
  )

  // Handoff → mirror the legacy behaviour: stop auto-replying and
  // leave the thread for a human.
  if (loop.status === 'handoff') {
    await db
      .from('conversations')
      .update({ ai_autoreply_disabled: true })
      .eq('id', args.conversationId)
    await markRun(db, args.accountId, runId, 'handoff_requested')
    return 'handoff'
  }

  if (loop.status === 'failed' || !loop.text) {
    await markRun(db, args.accountId, runId, 'failed', loop.error ?? 'EMPTY_REPLY')
    return 'failed'
  }

  // Persist the run as succeeded BEFORE the network send so a
  // crash mid-send still leaves the answer auditable (and the
  // idempotency key prevents any retry from double-sending).
  await db
    .from('ai_agent_runs')
    .update({ status: 'succeeded', completed_at: new Date().toISOString() })
    .eq('id', runId)
    .eq('status', 'claimed')

  // LIVE SEND via the shared engine channel (service-role scoped,
  // account-verified contact + WhatsApp config, phone-variant
  // retry built in).
  console.info('[ai dispatch] sending reply via WhatsApp...')
  const sent = await engineSendText({
    accountId: args.accountId,
    userId: args.configOwnerUserId,
    conversationId: args.conversationId,
    contactId: args.contactId ?? '',
    text: loop.text,
  })

  await db
    .from('ai_agent_runs')
    .update({ outbound_message_id: sent.whatsapp_message_id })
    .eq('id', runId)
  console.info(`[ai dispatch] SENT run=${runId.slice(0, 8)} wa_id=${sent.whatsapp_message_id}`)

  return 'succeeded'
}

async function markRun(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: AccountId,
  runId: Uuid,
  outcome: 'handoff_requested' | 'failed',
  errorCode?: string,
): Promise<void> {
  await db
    .from('ai_agent_runs')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_code: errorCode ?? outcome,
    })
    .eq('id', runId)
    .eq('status', 'claimed')
  await db.rpc('append_agent_run_event', {
    p_account_id: accountId,
    p_run_id: runId,
    p_event_type: 'failed',
    p_actor_type: 'service',
    p_actor_id: 'agent-loop',
    p_payload: { outcome, error_code: errorCode ?? null },
  })
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
      case 'coverage.find_offers':
        result = await executeCoverageFindOffers(ctx, invocation.args as never)
        break
      case 'coverage.propose_offer':
        result = await executeCoverageProposeOffer(ctx, invocation.args as never)
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
