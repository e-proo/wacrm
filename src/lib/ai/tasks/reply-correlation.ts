import { supabaseAdmin } from '../admin-client'
import { loadAccountRuntimePolicy } from '../runtime/runtime-policy'
import type { TaskReplyRoutingSignal } from '../runtime/multi-agent-types'

export type TaskReplyCorrelationStatus =
  | 'matched'
  | 'no_match'
  | 'ambiguous'
  | 'human_paused'
  | 'correlated_unroutable'
  | 'inbound_already_routed'
  | 'disabled'

export interface TaskReplyCorrelationResult {
  status: TaskReplyCorrelationStatus
  reason: string
  signal: TaskReplyRoutingSignal | null
  candidateCount: number | null
  pausedTargets: number | null
}

/**
 * Resolve an already-persisted inbound customer message against active Agent
 * Task targets. The database is the concurrency / idempotency authority and
 * atomically creates the task-linked inbound run when exactly one target owns
 * the reply.
 *
 * Trusted-admin precedence is intentionally NOT decided here. The WhatsApp
 * webhook resolves the admin plane before calling this customer-plane helper.
 */
export async function correlateInboundTaskReply(input: {
  accountId: string
  conversationId: string
  inboundMessageId: string
  replyToMessageId?: string | null
  hasHumanAssignee: boolean
}): Promise<TaskReplyCorrelationResult> {
  const db = supabaseAdmin()
  const policy = await loadAccountRuntimePolicy(db, input.accountId)

  if (
    policy.killSwitch ||
    !policy.multiAgentEnabled ||
    !policy.recoveryWorkerEnabled
  ) {
    return {
      status: 'disabled',
      reason: policy.killSwitch
        ? 'account_kill_switch'
        : !policy.multiAgentEnabled
          ? 'account_multi_agent_disabled'
          : 'recovery_worker_disabled',
      signal: null,
      candidateCount: null,
      pausedTargets: null,
    }
  }

  const { data, error } = await db.rpc(
    'correlate_agent_task_inbound_reply',
    {
      p_account_id: input.accountId,
      p_conversation_id: input.conversationId,
      p_inbound_message_id: input.inboundMessageId,
      p_reply_to_message_id: input.replyToMessageId ?? null,
      p_has_human_assignee: input.hasHumanAssignee,
    },
  )
  if (error) throw error

  return normalizeTaskReplyCorrelation(data)
}

export function normalizeTaskReplyCorrelation(
  raw: unknown,
): TaskReplyCorrelationResult {
  const value =
    raw && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : {}

  const rawStatus =
    typeof value.status === 'string' ? value.status : 'no_match'
  const status: TaskReplyCorrelationStatus = isCorrelationStatus(rawStatus)
    ? rawStatus
    : 'no_match'

  const reason =
    typeof value.reason === 'string' && value.reason
      ? value.reason
      : 'unknown'

  const signal =
    status === 'matched'
      ? normalizeMatchedSignal(value)
      : null

  return {
    status,
    reason,
    signal,
    candidateCount:
      typeof value.candidate_count === 'number'
        ? value.candidate_count
        : null,
    pausedTargets:
      typeof value.paused_targets === 'number'
        ? value.paused_targets
        : null,
  }
}

function normalizeMatchedSignal(
  value: Record<string, unknown>,
): TaskReplyRoutingSignal {
  const required = [
    'run_id',
    'task_id',
    'task_target_id',
    'agent_id',
    'agent_revision_id',
    'provider_connection_id',
    'counterparty_role',
    'correlation_method',
  ] as const

  for (const field of required) {
    if (typeof value[field] !== 'string' || !value[field]) {
      throw new Error(`TASK_REPLY_CORRELATION_FIELD_MISSING:${field}`)
    }
  }

  return {
    runId: value.run_id as string,
    taskId: value.task_id as string,
    taskTargetId: value.task_target_id as string,
    agentId: value.agent_id as string,
    revisionId: value.agent_revision_id as string,
    providerConnectionId: value.provider_connection_id as string,
    counterpartyRole: value.counterparty_role as string,
    correlationMethod: value.correlation_method as string,
  }
}

function isCorrelationStatus(
  value: string,
): value is TaskReplyCorrelationStatus {
  return [
    'matched',
    'no_match',
    'ambiguous',
    'human_paused',
    'correlated_unroutable',
    'inbound_already_routed',
    'disabled',
  ].includes(value)
}
