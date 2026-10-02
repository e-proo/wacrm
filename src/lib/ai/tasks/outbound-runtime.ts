import { supabaseAdmin } from '../admin-client'
import { recordRuntimeCircuitEvent } from '../runtime/circuit-breaker'
import { CURRENT_AGENT_TASK_PLATFORM } from './current-platform'
import {
  assertValidOutboundMessageCandidate,
  type AgentTaskOutboundMessageCandidate,
} from './outbound-policy'

export interface AgentTaskOutboundReservationDecision {
  reserved: boolean
  reason: string
  reservationId: string | null
  status: string | null
  messageKind: 'text' | 'template' | null
  sessionWindowActive: boolean | null
  idempotencyKey: string | null
}

export type PrepareAgentTaskOutboundResult =
  | {
      status: 'reserved' | 'denied'
      candidate: AgentTaskOutboundMessageCandidate
      decision: AgentTaskOutboundReservationDecision
    }
  | {
      status:
        | 'run_not_found'
        | 'run_not_claimed'
        | 'task_not_found'
        | 'target_not_found'
        | 'task_type_not_registered'
        | 'message_policy_not_registered'
      candidate: null
      decision: null
    }

/**
 * Convert an already-claimed outbound Agent Run into a durable outbound
 * reservation. This function never calls Meta/WhatsApp.
 *
 * The domain-owned policy prepares the candidate, then the database is the
 * final authority for session-window/template/suppression/follow-up checks.
 */
export async function prepareAndReserveCurrentTaskOutboundMessage(input: {
  runId: string
  modelCandidateText?: string | null
}): Promise<PrepareAgentTaskOutboundResult> {
  const db = supabaseAdmin()

  const { data: run, error: runError } = await db
    .from('ai_agent_runs')
    .select(
      'id, account_id, task_id, task_target_id, run_mode, status, counterparty_role',
    )
    .eq('id', input.runId)
    .maybeSingle()
  if (runError) throw runError
  if (!run) {
    return { status: 'run_not_found', candidate: null, decision: null }
  }

  const runRow = run as {
    id: string
    account_id: string
    task_id: string | null
    task_target_id: string | null
    run_mode: string
    status: string
    counterparty_role: string | null
  }

  if (
    runRow.run_mode !== 'outbound' ||
    runRow.status !== 'claimed' ||
    !runRow.task_id ||
    !runRow.task_target_id
  ) {
    return { status: 'run_not_claimed', candidate: null, decision: null }
  }

  const [{ data: task, error: taskError }, { data: target, error: targetError }] =
    await Promise.all([
      db
        .from('ai_agent_tasks')
        .select(
          'id, account_id, task_type, task_type_version, objective, task_context, target_policy, channel',
        )
        .eq('account_id', runRow.account_id)
        .eq('id', runRow.task_id)
        .maybeSingle(),
      db
        .from('ai_agent_task_targets')
        .select('id, account_id, task_id, counterparty_role')
        .eq('account_id', runRow.account_id)
        .eq('task_id', runRow.task_id)
        .eq('id', runRow.task_target_id)
        .maybeSingle(),
    ])

  if (taskError) throw taskError
  if (targetError) throw targetError
  if (!task) {
    return { status: 'task_not_found', candidate: null, decision: null }
  }
  if (!target) {
    return { status: 'target_not_found', candidate: null, decision: null }
  }

  const taskRow = task as {
    id: string
    account_id: string
    task_type: string
    task_type_version: number
    objective: string
    task_context: Record<string, unknown> | null
    target_policy: Record<string, unknown> | null
    channel: string
  }
  const targetRow = target as {
    id: string
    counterparty_role: string
  }

  const manifest = CURRENT_AGENT_TASK_PLATFORM.taskTypes.get(
    taskRow.task_type,
    taskRow.task_type_version,
  )
  if (!manifest) {
    return {
      status: 'task_type_not_registered',
      candidate: null,
      decision: null,
    }
  }

  if (!manifest.allowedChannels.includes(taskRow.channel as never)) {
    throw new Error('OUTBOUND_TASK_CHANNEL_NOT_ALLOWED')
  }

  const policy = CURRENT_AGENT_TASK_PLATFORM.outboundMessagePolicies.get(
    manifest.messagePolicy.key,
    manifest.messagePolicy.version,
  )
  if (!policy || policy.domain !== manifest.domain) {
    return {
      status: 'message_policy_not_registered',
      candidate: null,
      decision: null,
    }
  }

  const candidate = assertValidOutboundMessageCandidate(
    await policy.prepare({
      accountId: runRow.account_id,
      runId: runRow.id,
      taskId: taskRow.id,
      taskTargetId: targetRow.id,
      taskType: taskRow.task_type,
      taskTypeVersion: taskRow.task_type_version,
      objective: taskRow.objective,
      taskContext: Object.freeze({ ...(taskRow.task_context ?? {}) }),
      targetPolicy: Object.freeze({ ...(taskRow.target_policy ?? {}) }),
      counterpartyRole:
        targetRow.counterparty_role || runRow.counterparty_role || 'counterparty',
      policy: manifest.messagePolicy,
      modelCandidateText: input.modelCandidateText?.trim() || null,
    }),
  )

  const params =
    candidate.kind === 'template' ? [...candidate.params] : []

  const { data, error } = await db.rpc('reserve_agent_task_outbound_message', {
    p_run_id: runRow.id,
    p_policy_key: policy.key,
    p_policy_version: policy.version,
    p_message_kind: candidate.kind,
    p_candidate_text: candidate.kind === 'text' ? candidate.text : null,
    p_template_name:
      candidate.kind === 'template' ? candidate.templateName : null,
    p_template_language:
      candidate.kind === 'template' ? candidate.language : null,
    p_template_params: params,
    p_max_followups: manifest.followupPolicy.maxFollowups,
    p_minimum_interval_minutes:
      manifest.followupPolicy.minimumIntervalMinutes,
    p_maximum_interval_minutes:
      manifest.followupPolicy.maximumIntervalMinutes,
    p_stop_on_reply: manifest.followupPolicy.stopOnReply,
  })
  if (error) {
    const guardReason = outboundBudgetGuardReason(error)
    if (!guardReason) throw error

    await recordRuntimeCircuitEvent({
      accountId: runRow.account_id,
      scopeType: 'task_type',
      scopeKey: taskRow.task_type + '@' + taskRow.task_type_version,
      outcome: 'rejection',
      errorCode: guardReason,
    })

    return {
      status: 'denied',
      candidate,
      decision: {
        reserved: false,
        reason: guardReason,
        reservationId: null,
        status: null,
        messageKind: candidate.kind,
        sessionWindowActive: null,
        idempotencyKey: null,
      },
    }
  }

  const decision = normalizeReservationDecision(data)

  if (!decision.reserved) {
    await recordRuntimeCircuitEvent({
      accountId: runRow.account_id,
      scopeType: 'task_type',
      scopeKey: taskRow.task_type + '@' + taskRow.task_type_version,
      outcome: 'rejection',
      errorCode: decision.reason,
    })
  }

  return {
    status: decision.reserved ? 'reserved' : 'denied',
    candidate,
    decision,
  }
}

export async function sweepAgentTaskOutboundReservations(
  now = new Date(),
): Promise<{ requiresReconciliation: number; cancelled: number }> {
  const db = supabaseAdmin()
  const { data, error } = await db.rpc('sweep_agent_task_outbound_messages', {
    p_now: now.toISOString(),
  })
  if (error) throw error

  const raw =
    data && typeof data === 'object'
      ? (data as Record<string, unknown>)
      : {}

  return {
    requiresReconciliation:
      Number(raw.requires_reconciliation ?? 0) || 0,
    cancelled: Number(raw.cancelled ?? 0) || 0,
  }
}

function normalizeReservationDecision(
  raw: unknown,
): AgentTaskOutboundReservationDecision {
  const value =
    raw && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : {}

  const kind =
    value.message_kind === 'text' || value.message_kind === 'template'
      ? value.message_kind
      : null

  return {
    reserved: value.reserved === true,
    reason:
      typeof value.reason === 'string' && value.reason
        ? value.reason
        : 'unknown',
    reservationId:
      typeof value.reservation_id === 'string'
        ? value.reservation_id
        : null,
    status:
      typeof value.status === 'string' ? value.status : null,
    messageKind: kind,
    sessionWindowActive:
      typeof value.session_window_active === 'boolean'
        ? value.session_window_active
        : null,
    idempotencyKey:
      typeof value.idempotency_key === 'string'
        ? value.idempotency_key
        : null,
  }
}


function outboundBudgetGuardReason(error: unknown): string | null {
  const text =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message?: unknown }).message ?? '')
      : error instanceof Error
        ? error.message
        : String(error ?? '')
  const upper = text.toUpperCase()

  const codes = [
    'AI_KILL_SWITCH',
    'OUTBOUND_TASK_DELIVERY_DISABLED',
    'ACCOUNT_DAILY_MESSAGE_BUDGET_EXCEEDED',
    'AGENT_PAUSED',
    'TASK_NOT_RUNNING',
    'TASK_DAILY_MESSAGE_BUDGET_EXCEEDED',
    'AGENT_BUDGET_MESSAGES_EXCEEDED',
    'AGENT_TASK_TYPE_DISABLED',
    'TASK_TYPE_DAILY_MESSAGE_LIMIT_EXCEEDED',
    'AGENT_CHANNEL_DISABLED',
    'CHANNEL_DAILY_MESSAGE_LIMIT_EXCEEDED',
  ] as const

  const code = codes.find((candidate) => upper.includes(candidate))
  if (!code) return null

  if (code === 'AGENT_BUDGET_MESSAGES_EXCEEDED') {
    const action = ['HANDOFF', 'PAUSE', 'CHEAPER_AGENT'].find((value) =>
      upper.includes(':' + value),
    )
    return action ? code + ':' + action.toLowerCase() : code
  }

  return code
}
