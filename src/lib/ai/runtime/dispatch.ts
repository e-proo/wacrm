// Server-only by convention.
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '../admin-client'
import { loadConversationAiState, loadRoutingSnapshotAdmin } from './repositories'
import { routeInboundMessage } from './router'
import { runAgentLoop } from './agent-loop'
import { engineSendText } from '@/lib/automations/meta-send'
import type { ChatMessage } from '../types'
import type { ToolContext, ToolResult } from '../tools/executors'
import { recordToolAttempt } from './tool-attempt-audit'
import { executeCurrentPlatformTool } from '../tools/platform/current-executor-registry'
import { loadAccountRuntimePolicy } from './runtime-policy'
import { authorizeToolInvocation } from './tool-policy'
import { canonicalizeE164 } from './phone-e164'
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
  TrustedAdminIdentity,
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
  inboxId?: string | null
  tags?: ReadonlyArray<string>
  language?: string | null
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
      'id, account_id, conversation_id, inbound_message_id, ai_agent_id, agent_revision_id, provider_connection_id, route_id, route_reason, plane, status',
    )
    .eq('id', runId)
    .maybeSingle()
  if (runError) throw runError
  if (!run) return 'lost'
  if (run.status === 'succeeded') return 'succeeded'
  if (run.status !== 'queued' && run.status !== 'claimed') return 'lost'

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

  const decision: Extract<RoutingDecision, { action: 'route' }> = {
    action: 'route',
    plane: run.plane as 'admin' | 'customer',
    agentId: run.ai_agent_id,
    revisionId: run.agent_revision_id,
    providerConnectionId: run.provider_connection_id,
    reason: run.route_reason ?? 'durable_worker_resume',
    routeId: run.route_id,
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
  const claimed = await db.rpc('claim_agent_run', {
    p_run_id: runId,
    p_claimed_by: workerId,
    // Lease must comfortably exceed AI_REQUEST_TIMEOUT_MS (default
    // 30s; reasoning models are configured to 120s) — a lease that
    // expires mid-run lets the recovery worker reclaim the run and
    // duplicate an in-flight provider call.
    p_lease_secs: 300,
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
      'id, agent_id, status, model, system_prompt, response_style, language_policy, temperature, max_output_tokens, max_tool_rounds, max_ai_replies_per_conversation, handoff_human_member_id',
    )
    .eq('id', decision.revisionId)
    .maybeSingle()
  if (revErr || !revision) {
    console.error('[ai dispatch] revision load failed:', revErr)
    await markRun(db, args.accountId, runId, 'failed', 'REVISION_NOT_FOUND')
    return 'failed'
  }
  // Map the snake_case row onto the camelCase revision type
  // EXPLICITLY. A blind `as AiAgentRevision` cast silently yields
  // undefined for maxToolRounds => the tool loop executed ZERO
  // rounds => 'failed' with no error (this exact bug).
  const rawRev = revision as {
    id: string
    agent_id: string
    status: string
    model: string
    system_prompt: string | null
    response_style: string
    language_policy: string
    temperature: number | null
    max_output_tokens: number | null
    max_tool_rounds: number
    max_ai_replies_per_conversation: number
    handoff_human_member_id: string | null
  }
  const rev: AiAgentRevision = {
    id: rawRev.id,
    accountId: args.accountId,
    agentId: rawRev.agent_id ?? decision.agentId,
    revisionNumber: 0,
    status: (rawRev.status as AiAgentRevision['status']) ?? 'published',
    providerConnectionId: decision.providerConnectionId,
    model: rawRev.model,
    systemPrompt: rawRev.system_prompt,
    responseStyle: (rawRev.response_style as AiAgentRevision['responseStyle']) ?? 'balanced',
    languagePolicy: rawRev.language_policy ?? 'auto',
    temperature: rawRev.temperature ?? null,
    maxOutputTokens: rawRev.max_output_tokens ?? null,
    maxToolRounds: rawRev.max_tool_rounds ?? 0,
    maxAiRepliesPerConversation: rawRev.max_ai_replies_per_conversation ?? 3,
    handoffHumanMemberId: rawRev.handoff_human_member_id ?? null,
    settings: {},
    createdAt: '',
    publishedAt: null,
    publishedBy: null,
    rejectionReason: null,
  }
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
  const agentPurpose =
    snapshot.agents.find(
      (entry: { agent: { id: string; purpose: string } }) =>
        entry.agent.id === decision.agentId,
    )?.agent.purpose ?? 'custom'
  console.info(
    `[ai dispatch] history=${history.length} msgs, purpose=${agentPurpose}`,
  )

  // The send needs an audit identity — fail BEFORE claiming a
  // reply slot or marking succeeded.
  if (!args.configOwnerUserId) {
    console.error('[ai dispatch] no configOwnerUserId — cannot send')
    await markRun(db, args.accountId, runId, 'failed', 'NO_CONFIG_OWNER')
    return 'failed'
  }

  // Customer conversations share the same atomic reply cap as the legacy
  // auto-reply path. Trusted-admin traffic is a separate operational plane:
  // identity/capability/budget gates apply, but customer reply history cannot
  // silence an administrator.
  if (decision.plane === 'customer') {
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
  } else {
    console.info('[ai dispatch] admin plane bypasses customer reply cap run=' + runId.slice(0, 8))
  }

  const loop = await runAgentLoop({
    accountId: args.accountId,
    runId,
    agentId: decision.agentId,
    agentPurpose: agentPurpose as 'customer_support' | 'admin_operations' | 'custom',
    revision: rev,
    messages: history,
    contactId: args.contactId,
    conversationId: args.conversationId,
    sourceMessageId: args.inboundMessageId,
    plane: decision.plane,
    channel: 'whatsapp',
    trustedAdminIdentityId:
      decision.plane === 'admin'
        ? snapshot.trustedIdentities.find(
            (identity) =>
              identity.status === 'active' &&
              identity.normalizedAddress === canonicalizeE164(args.senderAddress),
          )?.id ?? null
        : null,
    trustedAdminCapabilities:
      decision.plane === 'admin'
        ? snapshot.trustedIdentities.find(
            (identity) =>
              identity.status === 'active' &&
              identity.normalizedAddress === canonicalizeE164(args.senderAddress),
          )?.allowedCapabilities ?? []
        : [],
  })
  console.info(
    `[ai dispatch] loop=${loop.status} tools=${loop.toolCalls.length} text=${loop.text ? loop.text.length + 'ch' : 'null'}`,
  )

  const latestInbound =
    [...history].reverse().find((message) => message.role === 'user')?.content ?? ''

  if (loop.status === 'handoff' && decision.plane === 'customer') {
    const summary = `AI handoff after customer message: ${latestInbound}`
    try {
      const handoff = await applyAgentHumanHandoff({
        db,
        accountId: args.accountId,
        runId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        targetUserId: rev.handoffHumanMemberId,
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
    loop.status === 'handoff' && decision.plane === 'admin'
      ? loop.text || localizedAdminFallback(latestInbound)
      : loop.text

  if (loop.status === 'failed' || !effectiveText) {
    await markRun(db, args.accountId, runId, 'failed', loop.error ?? 'EMPTY_REPLY')
    return 'failed'
  }

  // LIVE SEND via the shared engine channel (service-role scoped,
  // account-verified contact + WhatsApp config). The send helper reserves a
  // unique local messages row keyed by this run BEFORE talking to Meta.
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

  // Only Meta success + durable local message persistence can make the run
  // succeeded. outbound_message_id stores messages.id (UUID), never wamid.
  const { data: completed, error: completeErr } = await db
    .from('ai_agent_runs')
    .update({
      status: 'succeeded',
      completed_at: new Date().toISOString(),
      outbound_message_id: sent.local_message_id,
      input_tokens: loop.inputTokens,
      output_tokens: loop.outputTokens,
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

  // DENY BY DEFAULT — the RUNNING REVISION must carry a grant for
  // this exact tool. The doc comment promised this check for phases
  // now and a half of shipping; without it a prompt-injected tool
  // call to ANY registered tool would execute.
  const grantedLvl = ctx.grants?.[invocation.toolKey]
  if (!grantedLvl) {
    await audit({ status: 'denied', errorCode: 'TOOL_NOT_GRANTED', toolVersion: tool.version })
    return {
      ...baseOutcome,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'TOOL_NOT_GRANTED',
        message: `Tool "${invocation.toolKey}" is not part of this assistant's capabilities.`,
      },
      toolFound: true,
      granted: false,
      roundsExhausted: false,
    }
  }
  const RANK: Record<ToolGrantPermission, number> = { read: 1, propose: 2, execute: 3 }
  if (RANK[invocation.permission] > RANK[grantedLvl]) {
    await audit({ status: 'denied', errorCode: 'TOOL_GRANT_LEVEL_DENIED', toolVersion: tool.version })
    return {
      ...baseOutcome,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'TOOL_GRANT_LEVEL_DENIED',
        message: `Tool "${invocation.toolKey}" is granted at level "${grantedLvl}", not "${invocation.permission}".`,
      },
      toolFound: true,
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

  const grantedVersion = ctx.grantVersions?.[invocation.toolKey]
  if (grantedVersion !== tool.version) {
    await audit({ status: 'denied', errorCode: 'TOOL_VERSION_MISMATCH', toolVersion: tool.version })
    return {
      ...baseOutcome,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'TOOL_VERSION_MISMATCH',
        message: `Tool "${invocation.toolKey}" grant is stale.`,
      },
      toolFound: true,
      granted: false,
      roundsExhausted: false,
    }
  }

  const policy = authorizeToolInvocation({
    tool,
    permission: invocation.permission,
    args: invocation.args,
    constraints: ctx.grantConstraints?.[invocation.toolKey] ?? {},
    context: {
      plane: ctx.plane,
      channel: ctx.channel,
      simulation: ctx.simulation,
      agentPurpose: ctx.agentPurpose,
      trustedAdminIdentityId: ctx.trustedAdminIdentityId,
      trustedAdminCapabilities: ctx.trustedAdminCapabilities,
      features: ctx.features,
    },
  })
  if (!policy.ok) {
    await audit({ status: 'denied', errorCode: policy.code, toolVersion: tool.version })
    return {
      ...baseOutcome,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: policy.code,
        message: policy.message,
      },
      toolFound: true,
      granted: false,
      roundsExhausted: false,
    }
  }

  const startedAt = Date.now()
  let result: ToolResult
  try {
    result = await executeCurrentPlatformTool(ctx, tool, invocation.args)
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
