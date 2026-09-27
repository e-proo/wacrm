// Server-only by convention.
import { supabaseAdmin } from '../admin-client'
import { loadConversationAiState, loadRoutingSnapshotAdmin } from './repositories'
import { routeInboundMessage } from './router'
import { engineSendText } from '@/lib/automations/meta-send'
import { deliverActiveBusinessEventNotifications } from '@/lib/services/platform/business-event-delivery'
import { loadAccountRuntimePolicy } from './runtime-policy'
import { canonicalizeE164 } from './phone-e164'
import {
  claimAgentExecution,
  loadAgentExecutionRevision,
  runClaimedAgentExecution,
  type AgentExecutionContext,
} from './execution'
import {
  applyAgentHumanHandoff,
  localizedAdminFallback,
  localizedHandoffAcknowledgement,
} from './handoff-service'
import type {
  AccountId,
  AiAgentRevision,
  RoutingDecision,
  RoutingSnapshot,
  TaskReplyRoutingSignal,
  TrustedAdminIdentity,
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
  inboxId?: string | null
  tags?: ReadonlyArray<string>
  language?: string | null
  taskReply?: TaskReplyRoutingSignal | null
}

export async function shouldRouteToMultiAgent(
  args: MultiAgentPreCheckArgs,
): Promise<boolean> {
  try {
    const db = supabaseAdmin()
    const [conversationAiState, snapshot, policy] = await Promise.all([
      loadConversationAiState(db, args.conversationId),
      loadRoutingSnapshotAdmin(args.accountId),
      loadAccountRuntimePolicy(db, args.accountId),
    ])
    if (policy.killSwitch || !policy.multiAgentEnabled) return false
    const decision = routeInboundMessage(
      {
        accountId: args.accountId,
        channel: 'whatsapp',
        senderAddress: args.senderAddress,
        conversationAiState,
        hasHumanAssignee: args.hasHumanAssignee,
        multiAgentEnabled: policy.multiAgentEnabled,
        inboxId: args.inboxId ?? null,
        tags: args.tags ?? [],
        language: args.language ?? null,
        taskReply: args.taskReply ?? null,
      },
      snapshot,
    )
    return decision.action === 'route'
  } catch (err) {
    console.error('[ai dispatch] pre-check failed, falling back to legacy:', err)
    return false
  }
}

/**
 * Resolve a trusted WhatsApp administrator BEFORE customer Flows and
 * Automations run. Deliberately throws when the routing snapshot cannot be
 * loaded so the webhook can fail closed instead of treating an unknown
 * sender plane as a customer message.
 */
export async function resolveTrustedAdminIdentity(input: {
  accountId: AccountId
  senderAddress: string
}): Promise<TrustedAdminIdentity | null> {
  const canonical = canonicalizeE164(input.senderAddress)
  if (!canonical) return null
  const snapshot = await loadRoutingSnapshotAdmin(input.accountId)
  return (
    snapshot.trustedIdentities.find(
      (identity) =>
        identity.status === 'active' &&
        identity.channel === 'whatsapp' &&
        identity.normalizedAddress === canonical,
    ) ?? null
  )
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
  inboxId?: string | null
  tags?: ReadonlyArray<string>
  language?: string | null
  taskReply?: TaskReplyRoutingSignal | null
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
    const policy = await loadAccountRuntimePolicy(db, args.accountId)
    if (policy.killSwitch) return skip('account_kill_switch')
    if (!policy.multiAgentEnabled) return skip('account_multi_agent_disabled')

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
        multiAgentEnabled: args.multiAgentEnabled && policy.multiAgentEnabled,
        inboxId: args.inboxId ?? null,
        tags: args.tags ?? [],
        language: args.language ?? null,
        taskReply: args.taskReply ?? null,
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
  if (decision.taskReply) {
    // Reply correlation already created the run atomically with the target
    // transition. Reuse that durable row instead of racing create_agent_run.
    return decision.taskReply.runId
  }

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

/**
 * Resume a durable queued run outside the webhook request. All routing
 * references come from the frozen ai_agent_runs row; conversation/contact
 * reads are only used to reconstruct send/context metadata.
 */
export async function resumeQueuedAgentRun(
  runId: Uuid,
  workerId: string,
): Promise<'succeeded' | 'handoff' | 'failed' | 'lost'> {
  const db = supabaseAdmin()
  const { data: run, error: runError } = await db
    .from('ai_agent_runs')
    .select(
      'id, account_id, conversation_id, inbound_message_id, ai_agent_id, agent_revision_id, provider_connection_id, route_id, route_reason, plane, status, run_mode, task_id, task_target_id, trigger_type, trigger_ref, counterparty_role',
    )
    .eq('id', runId)
    .maybeSingle()
  if (runError) throw runError
  if (!run) return 'lost'
  if (run.status === 'succeeded') return 'succeeded'
  if (run.status !== 'queued' && run.status !== 'claimed') return 'lost'
  if (run.run_mode !== 'inbound' || !run.inbound_message_id) return 'lost'

  const [conversationRes, configRes, snapshot] = await Promise.all([
    db
      .from('conversations')
      .select('id, contact_id, assigned_agent_id')
      .eq('id', run.conversation_id)
      .maybeSingle(),
    db
      .from('whatsapp_config')
      .select('user_id')
      .eq('account_id', run.account_id)
      .maybeSingle(),
    loadRoutingSnapshotAdmin(run.account_id),
  ])
  if (conversationRes.error) throw conversationRes.error
  if (configRes.error) throw configRes.error
  if (!conversationRes.data) return 'failed'

  const contactId = conversationRes.data.contact_id as string | null
  const { data: contact, error: contactError } = contactId
    ? await db
        .from('contacts')
        .select('phone')
        .eq('account_id', run.account_id)
        .eq('id', contactId)
        .maybeSingle()
    : { data: null, error: null }
  if (contactError) throw contactError

  const taskReply: TaskReplyRoutingSignal | undefined =
    run.trigger_type === 'task_reply' &&
    run.task_id &&
    run.task_target_id
      ? {
          runId: run.id,
          taskId: run.task_id,
          taskTargetId: run.task_target_id,
          agentId: run.ai_agent_id,
          revisionId: run.agent_revision_id,
          providerConnectionId: run.provider_connection_id,
          counterpartyRole: run.counterparty_role ?? 'task_counterparty',
          correlationMethod: run.trigger_ref ?? 'durable_worker_resume',
        }
      : undefined

  const decision: Extract<RoutingDecision, { action: 'route' }> = {
    action: 'route',
    plane: run.plane as 'admin' | 'customer',
    agentId: run.ai_agent_id,
    revisionId: run.agent_revision_id,
    providerConnectionId: run.provider_connection_id,
    reason: run.route_reason ?? 'durable_worker_resume',
    routeId: run.route_id,
    ...(taskReply ? { taskReply } : {}),
  }
  return executeAgentRun(
    {
      accountId: run.account_id,
      conversationId: run.conversation_id,
      inboundMessageId: run.inbound_message_id,
      contactId,
      configOwnerUserId: configRes.data?.user_id ?? null,
      senderAddress: contact?.phone ?? '',
      hasHumanAssignee: Boolean(conversationRes.data.assigned_agent_id),
      multiAgentEnabled: true,
      workerId,
      taskReply,
    },
    runId,
    decision,
    snapshot,
    workerId,
  )
}

async function executeAgentRun(
  args: DispatchInboundArgs,
  runId: Uuid,
  decision: Extract<RoutingDecision, { action: 'route' }>,
  snapshot: RoutingSnapshot,
  workerId: string,
): Promise<'succeeded' | 'handoff' | 'failed' | 'lost'> {
  const db = supabaseAdmin()

  const claim = await claimAgentExecution({ runId, workerId, leaseSeconds: 300 })
  if (claim !== 'claimed') {
    console.info('[ai dispatch] claim lost (another worker?) run=' + runId.slice(0, 8))
    return 'lost'
  }
  console.info('[ai dispatch] claimed run=' + runId.slice(0, 8))

  const revisionResult = await loadAgentExecutionRevision({
    accountId: args.accountId,
    agentId: decision.agentId,
    revisionId: decision.revisionId,
    providerConnectionId: decision.providerConnectionId,
  })
  if (!revisionResult.ok) {
    await markRun(db, args.accountId, runId, 'failed', revisionResult.error)
    return 'failed'
  }
  const revision = revisionResult.revision

  // Sending is inbound-entrypoint policy, not part of the generic execution
  // runtime. Fail before generation if this channel cannot audit a send.
  if (!args.configOwnerUserId) {
    console.error('[ai dispatch] no configOwnerUserId — cannot send')
    await markRun(db, args.accountId, runId, 'failed', 'NO_CONFIG_OWNER')
    return 'failed'
  }

  // Preserve the existing customer reply-cap semantics for ordinary inbound
  // support. A correlated Task reply belongs to the Task Platform and is
  // bounded by target/task attempt + follow-up policies instead.
  if (decision.plane === 'customer' && !decision.taskReply) {
    const { data: slot, error: slotErr } = await db.rpc('claim_ai_reply_slot', {
      conversation_id: args.conversationId,
      max_replies: revision.maxAiRepliesPerConversation ?? 3,
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
  } else if (decision.taskReply) {
    console.info(
      '[ai dispatch] task reply uses task limits run=' + runId.slice(0, 8),
    )
  } else {
    console.info(
      '[ai dispatch] admin plane bypasses customer reply cap run=' +
        runId.slice(0, 8),
    )
  }

  const trustedAdmin =
    decision.plane === 'admin'
      ? snapshot.trustedIdentities.find(
          (identity) =>
            identity.status === 'active' &&
            identity.normalizedAddress === canonicalizeE164(args.senderAddress),
        ) ?? null
      : null

  const context: AgentExecutionContext = {
    accountId: args.accountId,
    runId,
    mode: 'inbound',
    agentId: decision.agentId,
    revisionId: decision.revisionId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    taskId: decision.taskReply?.taskId ?? null,
    taskTargetId: decision.taskReply?.taskTargetId ?? null,
    plane: decision.plane,
    counterpartyRole:
      decision.taskReply?.counterpartyRole ??
      (decision.plane === 'admin' ? 'administrator' : 'customer'),
    channel: 'whatsapp',
    sourceMessageId: args.inboundMessageId,
  }

  const execution = await runClaimedAgentExecution({
    context,
    revision,
    trustedAdminIdentityId: trustedAdmin?.id ?? null,
    trustedAdminCapabilities: trustedAdmin?.allowedCapabilities ?? [],
  })

  // Proposal tools may commit customer-facing business events transactionally
  // before the model produces its final reply. Flush only events correlated to
  // this run so the durable business event remains the authoritative response.
  let correlatedBusinessEventMessageId: string | null = null
  if (
    decision.plane === 'customer' &&
    execution.toolCalls.some((call) => call.ok)
  ) {
    try {
      const delivery = await deliverActiveBusinessEventNotifications({
        accountId: args.accountId,
        userId: args.configOwnerUserId,
        correlationId: runId,
        limit: 20,
      })
      if (delivery.claimed > 0) {
        console.info(
          `[ai dispatch] correlated business events claimed=${delivery.claimed} sent=${delivery.sent} reconcile=${delivery.reconciliation} failed=${delivery.failed}`,
        )
      }
      if (delivery.sent > 0 && delivery.lastLocalMessageId) {
        correlatedBusinessEventMessageId = delivery.lastLocalMessageId
      }
    } catch (deliveryError) {
      console.error('[ai dispatch] correlated business event delivery failed:', deliveryError)
    }
  }

  const latestInbound = execution.latestUserMessage

  if (execution.status === 'needs_human' && decision.plane === 'customer') {
    const summary = `AI handoff after customer message: ${latestInbound}`
    try {
      const handoff = await applyAgentHumanHandoff({
        db,
        accountId: args.accountId,
        runId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        targetUserId: revision.handoffHumanMemberId,
        summary,
      })
      console.info(
        `[ai dispatch] handoff assigned=${handoff.assignedUserId ?? 'none'} changed=${handoff.assignmentChanged} explicit_notification=${handoff.explicitNotificationCreated}`,
      )
    } catch (handoffErr) {
      console.error('[ai dispatch] handoff assignment failed:', handoffErr)
      await markRun(db, args.accountId, runId, 'failed', 'HANDOFF_ASSIGNMENT_FAILED')
      return 'failed'
    }

    if (args.contactId) {
      try {
        await engineSendText({
          accountId: args.accountId,
          userId: args.configOwnerUserId,
          conversationId: args.conversationId,
          contactId: args.contactId,
          text: localizedHandoffAcknowledgement(latestInbound),
          aiAgentRunId: runId,
        })
      } catch (sendErr) {
        console.error('[ai dispatch] handoff acknowledgement send failed:', sendErr)
      }
    }
    await markRun(db, args.accountId, runId, 'handoff_requested')
    return 'handoff'
  }

  // A trusted administrator is already the human authority. Model-level
  // customer handoff semantics must never turn an admin message into silence.
  const effectiveText =
    execution.status === 'needs_human' && decision.plane === 'admin'
      ? execution.customerMessage || localizedAdminFallback(latestInbound)
      : execution.customerMessage

  if (execution.status === 'failed' || !effectiveText) {
    await markRun(
      db,
      args.accountId,
      runId,
      'failed',
      execution.error ?? 'EMPTY_REPLY',
    )
    return 'failed'
  }

  if (correlatedBusinessEventMessageId) {
    const { data: completed, error: completeErr } = await db
      .from('ai_agent_runs')
      .update({
        status: 'succeeded',
        completed_at: new Date().toISOString(),
        outbound_message_id: correlatedBusinessEventMessageId,
        input_tokens: execution.usage.inputTokens,
        output_tokens: execution.usage.outputTokens,
        error_code: null,
      })
      .eq('id', runId)
      .eq('status', 'claimed')
      .select('id')
      .maybeSingle()
    if (completeErr || !completed) {
      console.error('[ai dispatch] business-event run completion CAS failed:', completeErr)
      return 'lost'
    }
    console.info(
      `[ai dispatch] business event already replied run=${runId.slice(0, 8)} local_message=${correlatedBusinessEventMessageId.slice(0, 8)}; suppressing model reply`,
    )
    return 'succeeded'
  }

  console.info('[ai dispatch] sending reply via WhatsApp...')
  let sent: Awaited<ReturnType<typeof engineSendText>>
  try {
    sent = await engineSendText({
      accountId: args.accountId,
      userId: args.configOwnerUserId,
      conversationId: args.conversationId,
      contactId: args.contactId ?? '',
      text: effectiveText,
      aiAgentRunId: runId,
    })
  } catch (sendErr) {
    console.error('[ai dispatch] WhatsApp send failed:', sendErr)
    await markRun(db, args.accountId, runId, 'failed', 'SEND_FAILED')
    return 'failed'
  }

  const { data: completed, error: completeErr } = await db
    .from('ai_agent_runs')
    .update({
      status: 'succeeded',
      completed_at: new Date().toISOString(),
      outbound_message_id: sent.local_message_id,
      input_tokens: execution.usage.inputTokens,
      output_tokens: execution.usage.outputTokens,
      error_code: null,
    })
    .eq('id', runId)
    .eq('status', 'claimed')
    .select('id')
    .maybeSingle()
  if (completeErr || !completed) {
    console.error('[ai dispatch] run completion CAS failed:', completeErr)
    return 'lost'
  }
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

export { executeTool } from './tool-execution'
export type { ToolInvocation, ToolExecutionOutcome } from './tool-execution'

// ------------------------------------------------------------
// Re-exports
// ------------------------------------------------------------
export { routeInboundMessage } from './router'
export type { RoutingDecision, AiAgentRevision }

// The legacy sweep function is unchanged.
export { sweepAgentRuns } from './recovery'
