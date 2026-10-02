import { supabaseAdmin } from '../admin-client'
import {
  claimAgentExecution,
  loadAgentExecutionRevision,
  runClaimedAgentExecution,
  type AgentExecutionContext,
} from '../runtime/execution'
import { loadAccountRuntimePolicy } from '../runtime/runtime-policy'
import {
  assertRuntimeCircuitClosed,
  RuntimeCircuitOpenError,
} from '../runtime/circuit-breaker'
import { deliverAgentTaskOutboundReservation } from './outbound-delivery'
import { prepareAndReserveCurrentTaskOutboundMessage } from './outbound-runtime'

export interface AgentTaskOutboundWorkerResult {
  scanned: number
  gated: number
  attempted: number
  reserved: number
  sent: number
  reconciliation: number
  denied: number
  failed: number
}

interface QueuedOutboundRun {
  id: string
  account_id: string
  conversation_id: string
  ai_agent_id: string
  agent_revision_id: string
  provider_connection_id: string
  plane: 'customer'
  task_id: string
  task_target_id: string
  counterparty_role: string | null
}

function errorCode(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'AGENT_OUTBOUND_FAILED'
}

async function failOutboundRun(input: {
  runId: string
  code: string
  delaySeconds?: number
}): Promise<void> {
  const { error } = await supabaseAdmin().rpc('fail_agent_task_outbound_run', {
    p_run_id: input.runId,
    p_error_code: errorCode(input.code),
    p_delay_secs: Math.max(0, Math.min(input.delaySeconds ?? 60, 86_400)),
  })
  if (error) throw error
}

/**
 * Process queued outbound Agent Task runs.
 *
 * The account-level outbound Task delivery gate is checked before claiming a
 * run. With the default false value this function is a no-op for live
 * transport, preserving the Service Platform Meta Gate C/D invariant while
 * the rest of the Task Platform can be verified.
 */
export async function processAgentTaskOutboundRunQueue(input: {
  workerId: string
  limit?: number
}): Promise<AgentTaskOutboundWorkerResult> {
  if (!input.workerId.trim()) {
    throw new Error('AGENT_OUTBOUND_WORKER_ID_REQUIRED')
  }

  const db = supabaseAdmin()
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100))
  const { data, error } = await db
    .from('ai_agent_runs')
    .select(
      'id, account_id, conversation_id, ai_agent_id, agent_revision_id, provider_connection_id, plane, task_id, task_target_id, counterparty_role',
    )
    .eq('run_mode', 'outbound')
    .eq('status', 'queued')
    .lte('available_at', new Date().toISOString())
    .order('available_at', { ascending: true })
    .limit(limit)
  if (error) throw error

  const result: AgentTaskOutboundWorkerResult = {
    scanned: (data ?? []).length,
    gated: 0,
    attempted: 0,
    reserved: 0,
    sent: 0,
    reconciliation: 0,
    denied: 0,
    failed: 0,
  }

  for (const raw of data ?? []) {
    const run = raw as QueuedOutboundRun
    if (!run.task_id || !run.task_target_id) {
      result.failed += 1
      continue
    }

    const policy = await loadAccountRuntimePolicy(db, run.account_id)
    if (
      policy.killSwitch ||
      !policy.multiAgentEnabled ||
      !policy.recoveryWorkerEnabled ||
      !policy.outboundTaskDeliveryEnabled
    ) {
      result.gated += 1
      continue
    }

    try {
      await assertRuntimeCircuitClosed({
        accountId: run.account_id,
        scopeType: 'channel',
        scopeKey: 'whatsapp',
      })
    } catch (error) {
      if (error instanceof RuntimeCircuitOpenError) {
        result.gated += 1
        continue
      }
      throw error
    }

    result.attempted += 1

    try {
      const claim = await claimAgentExecution({
        runId: run.id,
        workerId: input.workerId,
        leaseSeconds: 300,
      })
      if (claim !== 'claimed') {
        result.denied += 1
        continue
      }

      const revision = await loadAgentExecutionRevision({
        accountId: run.account_id,
        agentId: run.ai_agent_id,
        revisionId: run.agent_revision_id,
        providerConnectionId: run.provider_connection_id,
      })
      if (!revision.ok) {
        await failOutboundRun({ runId: run.id, code: revision.error })
        result.failed += 1
        continue
      }

      const { data: target, error: targetError } = await db
        .from('ai_agent_task_targets')
        .select('contact_id, conversation_id, counterparty_role')
        .eq('account_id', run.account_id)
        .eq('task_id', run.task_id)
        .eq('id', run.task_target_id)
        .maybeSingle()
      if (targetError) throw targetError
      if (!target?.contact_id || !target.conversation_id) {
        await failOutboundRun({
          runId: run.id,
          code: 'AGENT_OUTBOUND_TARGET_CONTEXT_MISSING',
        })
        result.failed += 1
        continue
      }

      const context: AgentExecutionContext = {
        accountId: run.account_id,
        runId: run.id,
        mode: 'outbound',
        agentId: run.ai_agent_id,
        revisionId: run.agent_revision_id,
        conversationId: target.conversation_id,
        contactId: target.contact_id,
        taskId: run.task_id,
        taskTargetId: run.task_target_id,
        plane: 'customer',
        counterpartyRole:
          target.counterparty_role ??
          run.counterparty_role ??
          'task_counterparty',
        channel: 'whatsapp',
        sourceMessageId: null,
      }

      const execution = await runClaimedAgentExecution({
        context,
        revision: revision.revision,
      })

      if (execution.status === 'failed' || execution.status === 'needs_human') {
        await failOutboundRun({
          runId: run.id,
          code:
            execution.error ??
            (execution.status === 'needs_human'
              ? 'AGENT_OUTBOUND_NEEDS_HUMAN'
              : 'AGENT_OUTBOUND_EXECUTION_FAILED'),
        })
        result.failed += 1
        continue
      }

      const reservation = await prepareAndReserveCurrentTaskOutboundMessage({
        runId: run.id,
        modelCandidateText: execution.customerMessage,
      })

      if (reservation.status !== 'reserved') {
        const code =
          reservation.decision?.reason ??
          reservation.status
        await failOutboundRun({ runId: run.id, code })
        result.denied += 1
        continue
      }

      const reservationId = reservation.decision.reservationId
      if (!reservationId) {
        await failOutboundRun({
          runId: run.id,
          code: 'AGENT_OUTBOUND_RESERVATION_ID_MISSING',
        })
        result.failed += 1
        continue
      }

      result.reserved += 1

      const delivery = await deliverAgentTaskOutboundReservation({
        reservationId,
        workerId: input.workerId,
        inputTokens: execution.usage.inputTokens,
        outputTokens: execution.usage.outputTokens,
      })

      if (delivery.status === 'sent' || delivery.status === 'already_sent') {
        result.sent += 1
        continue
      }

      if (delivery.status === 'requires_reconciliation') {
        result.reconciliation += 1
        continue
      }

      await failOutboundRun({
        runId: run.id,
        code: delivery.reason || delivery.status,
      })
      result.denied += 1
    } catch (workerError) {
      result.failed += 1
      const detail =
        workerError instanceof Error
          ? workerError.message
          : String(workerError)
      console.error(
        '[agent outbound worker] run failed:',
        run.id,
        workerError,
      )
      try {
        await failOutboundRun({ runId: run.id, code: detail })
      } catch (persistError) {
        console.error(
          '[agent outbound worker] failure transition failed:',
          run.id,
          persistError,
        )
      }
    }
  }

  return result
}
