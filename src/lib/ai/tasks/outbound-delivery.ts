import { engineSendTemplate, engineSendText } from '@/lib/automations/meta-send'
import { resolveWhatsAppTransport } from '@/lib/whatsapp/transport/router'
import { supabaseAdmin } from '../admin-client'
import {
  assertRuntimeCircuitClosed,
  circuitErrorCode,
  recordRuntimeCircuitEvent,
  RuntimeCircuitOpenError,
} from '../runtime/circuit-breaker'

export interface AgentTaskOutboundDeliveryResult {
  status:
    | 'sent'
    | 'already_sent'
    | 'denied'
    | 'requires_reconciliation'
    | 'not_found'
  reason: string
  reservationId: string
  localMessageId: string | null
  whatsappMessageId: string | null
}

interface OutboundTransport {
  sendText(input: {
    accountId: string
    userId: string
    conversationId: string
    contactId: string
    text: string
    engineIdempotencyKey: string
    connectionId: string
    expectedProvider: 'meta_cloud' | 'openwa'
    workload: 'agent'
  }): Promise<{ whatsapp_message_id: string; local_message_id: string }>
  sendTemplate(input: {
    accountId: string
    userId: string
    conversationId: string
    contactId: string
    templateName: string
    language: string
    params: string[]
    connectionId: string
    expectedProvider: 'meta_cloud' | 'openwa'
    workload: 'agent'
  }): Promise<{ whatsapp_message_id: string }>
}

const DEFAULT_TRANSPORT: OutboundTransport = {
  sendText: engineSendText,
  sendTemplate: engineSendTemplate,
}

/**
 * Deliver one already-reserved Agent Task outbound message.
 *
 * Transport ownership is claimed in SQL immediately before the frozen-provider call.
 * Any exception after that claim is treated as ambiguous and is never
 * automatically retried: the reservation moves to requires_reconciliation.
 */
export async function deliverAgentTaskOutboundReservation(input: {
  reservationId: string
  workerId: string
  inputTokens?: number
  outputTokens?: number
  transport?: OutboundTransport
}): Promise<AgentTaskOutboundDeliveryResult> {
  if (!input.workerId.trim()) {
    throw new Error('AGENT_OUTBOUND_WORKER_ID_REQUIRED')
  }

  const db = supabaseAdmin()
  const transport = input.transport ?? DEFAULT_TRANSPORT

  const { data: reservation, error: reservationError } = await db
    .from('ai_agent_task_outbound_messages')
    .select(
      'id, account_id, task_id, task_target_id, run_id, status, message_kind, candidate_text, template_name, template_language, template_params, idempotency_key, local_message_id, whatsapp_message_id, provider, connection_id',
    )
    .eq('id', input.reservationId)
    .maybeSingle()
  if (reservationError) throw reservationError
  if (!reservation) {
    return {
      status: 'not_found',
      reason: 'not_found',
      reservationId: input.reservationId,
      localMessageId: null,
      whatsappMessageId: null,
    }
  }

  const row = reservation as {
    id: string
    account_id: string
    task_id: string
    task_target_id: string
    run_id: string
    status: string
    message_kind: 'text' | 'template'
    candidate_text: string | null
    template_name: string | null
    template_language: string | null
    template_params: unknown
    idempotency_key: string
    local_message_id: string | null
    whatsapp_message_id: string | null
    provider: 'meta_cloud' | 'openwa' | null
    connection_id: string | null
  }

  if (row.status === 'sent') {
    return {
      status: 'already_sent',
      reason: 'already_sent',
      reservationId: row.id,
      localMessageId: row.local_message_id,
      whatsappMessageId: row.whatsapp_message_id,
    }
  }

  if (row.status === 'reserved' && (!row.connection_id || !row.provider)) {
    return {
      status: 'denied',
      reason: 'connection_unbound',
      reservationId: row.id,
      localMessageId: row.local_message_id,
      whatsappMessageId: row.whatsapp_message_id,
    }
  }

  const { data: target, error: targetError } = await db
    .from('ai_agent_task_targets')
    .select('contact_id, conversation_id')
    .eq('account_id', row.account_id)
    .eq('task_id', row.task_id)
    .eq('id', row.task_target_id)
    .maybeSingle()
  if (targetError) throw targetError
  if (!target?.contact_id || !target.conversation_id) {
    throw new Error('AGENT_OUTBOUND_TARGET_CONTEXT_MISSING')
  }
  const { data: conversation, error: conversationError } = await db
    .from('conversations')
    .select('id, user_id, contact_id')
    .eq('account_id', row.account_id)
    .eq('id', target.conversation_id)
    .maybeSingle()
  if (conversationError || !conversation || conversation.contact_id !== target.contact_id) {
    throw new Error('AGENT_OUTBOUND_CONVERSATION_CONTEXT_MISMATCH')
  }

  try {
    await assertRuntimeCircuitClosed({
      accountId: row.account_id,
      scopeType: 'channel',
      scopeKey: 'whatsapp',
    })
  } catch (error) {
    if (error instanceof RuntimeCircuitOpenError) {
      const { error: cancelError } = await db
        .from('ai_agent_task_outbound_messages')
        .update({
          status: 'cancelled',
          error_code: error.code,
          error_detail: 'WhatsApp channel circuit is open.',
        })
        .eq('id', row.id)
        .eq('status', 'reserved')
      if (cancelError) throw cancelError

      return {
        status: 'denied',
        reason: error.code,
        reservationId: row.id,
        localMessageId: row.local_message_id,
        whatsappMessageId: row.whatsapp_message_id,
      }
    }
    throw error
  }

  // Resolve credentials and exact session BEFORE claiming transport ownership.
  // This never dispatches a message; missing credentials are a known
  // pre-dispatch denial, not an ambiguous WhatsApp timeout.
  if (row.status === 'reserved') {
    try {
      const selected = await resolveWhatsAppTransport(
        db,
        row.account_id,
        row.connection_id,
      )
      if (
        selected.connectionId !== row.connection_id ||
        selected.transport.provider !== row.provider
      ) {
        throw new Error('AGENT_OUTBOUND_FROZEN_CONNECTION_MISMATCH')
      }
    } catch {
      return {
        status: 'denied',
        reason: 'connection_preflight_failed',
        reservationId: row.id,
        localMessageId: row.local_message_id,
        whatsappMessageId: row.whatsapp_message_id,
      }
    }
  }

  const { data: claimed, error: claimError } = await db.rpc(
    'claim_bound_agent_task_outbound_message',
    {
      p_reservation_id: row.id,
      p_worker_id: input.workerId,
      p_lease_secs: 180,
    },
  )
  if (claimError) throw claimError

  const claim =
    claimed && typeof claimed === 'object'
      ? (claimed as Record<string, unknown>)
      : {}

  if (claim.claimed !== true) {
    const reason =
      typeof claim.reason === 'string' ? claim.reason : 'claim_denied'

    if (reason === 'already_sent') {
      return {
        status: 'already_sent',
        reason,
        reservationId: row.id,
        localMessageId:
          typeof claim.local_message_id === 'string'
            ? claim.local_message_id
            : row.local_message_id,
        whatsappMessageId:
          typeof claim.whatsapp_message_id === 'string'
            ? claim.whatsapp_message_id
            : row.whatsapp_message_id,
      }
    }

    if (reason === 'reconciliation_required') {
      return {
        status: 'requires_reconciliation',
        reason,
        reservationId: row.id,
        localMessageId: row.local_message_id,
        whatsappMessageId: row.whatsapp_message_id,
      }
    }

    return {
      status: 'denied',
      reason,
      reservationId: row.id,
      localMessageId: row.local_message_id,
      whatsappMessageId: row.whatsapp_message_id,
    }
  }

  let transportSucceeded = false
  try {
    let localMessageId: string
    let whatsappMessageId: string

    if (row.message_kind === 'text') {
      if (!row.candidate_text?.trim()) {
        throw new Error('AGENT_OUTBOUND_RESERVED_TEXT_MISSING')
      }

      const sent = await transport.sendText({
        accountId: row.account_id,
        userId: conversation.user_id,
        conversationId: target.conversation_id,
        contactId: target.contact_id,
        text: row.candidate_text,
        engineIdempotencyKey: row.idempotency_key,
        connectionId: row.connection_id!,
        expectedProvider: row.provider!,
        workload: 'agent',
      })
      localMessageId = sent.local_message_id
      whatsappMessageId = sent.whatsapp_message_id
      transportSucceeded = true
    } else {
      if (!row.template_name || !row.template_language) {
        throw new Error('AGENT_OUTBOUND_RESERVED_TEMPLATE_MISSING')
      }

      const sent = await transport.sendTemplate({
        accountId: row.account_id,
        userId: conversation.user_id,
        conversationId: target.conversation_id,
        contactId: target.contact_id,
        templateName: row.template_name,
        language: row.template_language,
        params: normalizeTemplateParams(row.template_params),
        connectionId: row.connection_id!,
        expectedProvider: row.provider!,
        workload: 'agent',
      })
      whatsappMessageId = sent.whatsapp_message_id
      transportSucceeded = true

      const { data: localMessage, error: localMessageError } = await db
        .from('messages')
        .select('id')
        .eq('conversation_id', target.conversation_id)
        .eq('message_id', whatsappMessageId)
        .maybeSingle()
      if (localMessageError) throw localMessageError
      if (!localMessage?.id) {
        throw new Error('AGENT_OUTBOUND_TEMPLATE_LOCAL_MESSAGE_MISSING')
      }
      localMessageId = localMessage.id
    }

    transportSucceeded = true
    await recordRuntimeCircuitEvent({
      accountId: row.account_id,
      scopeType: 'channel',
      scopeKey: 'whatsapp',
      outcome: 'success',
      runId: row.run_id,
      taskId: row.task_id,
    })

    const { data: completed, error: completionError } = await db.rpc(
      'complete_agent_task_outbound_message',
      {
        p_reservation_id: row.id,
        p_worker_id: input.workerId,
        p_local_message_id: localMessageId,
        p_whatsapp_message_id: whatsappMessageId,
        p_input_tokens: Math.max(input.inputTokens ?? 0, 0),
        p_output_tokens: Math.max(input.outputTokens ?? 0, 0),
      },
    )
    if (completionError) throw completionError
    if (completed !== true) {
      throw new Error('AGENT_OUTBOUND_COMPLETION_CLAIM_LOST')
    }

    return {
      status: 'sent',
      reason: 'sent',
      reservationId: row.id,
      localMessageId,
      whatsappMessageId,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (!transportSucceeded) {
      await recordRuntimeCircuitEvent({
        accountId: row.account_id,
        scopeType: 'channel',
        scopeKey: 'whatsapp',
        outcome: 'failure',
        errorCode: circuitErrorCode(error),
        runId: row.run_id,
        taskId: row.task_id,
      })
    }
    const { error: reconciliationError } = await db.rpc(
      'mark_agent_task_outbound_reconciliation',
      {
        p_reservation_id: row.id,
        p_worker_id: input.workerId,
        p_error_code: outboundErrorCode(error),
        p_error_detail: detail,
      },
    )

    if (reconciliationError) {
      console.error(
        '[agent outbound] failed to persist reconciliation state:',
        reconciliationError,
      )
    }

    console.error(
      '[agent outbound] ambiguous transport outcome requires reconciliation:',
      row.id,
      error,
    )

    return {
      status: 'requires_reconciliation',
      reason: 'transport_outcome_ambiguous',
      reservationId: row.id,
      localMessageId: null,
      whatsappMessageId: null,
    }
  }
}

function normalizeTemplateParams(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is string => typeof value === 'string')
}

function outboundErrorCode(error: unknown): string {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'OUTBOUND_TRANSPORT_ERROR'

  const code = text
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120)

  return code || 'OUTBOUND_TRANSPORT_ERROR'
}
