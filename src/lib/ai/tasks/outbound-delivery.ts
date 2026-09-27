import { engineSendTemplate, engineSendText } from '@/lib/automations/meta-send'
import { supabaseAdmin } from '../admin-client'

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
  }): Promise<{ whatsapp_message_id: string; local_message_id: string }>
  sendTemplate(input: {
    accountId: string
    userId: string
    conversationId: string
    contactId: string
    templateName: string
    language: string
    params: string[]
  }): Promise<{ whatsapp_message_id: string }>
}

const DEFAULT_TRANSPORT: OutboundTransport = {
  sendText: engineSendText,
  sendTemplate: engineSendTemplate,
}

/**
 * Deliver one already-reserved Agent Task outbound message.
 *
 * Transport ownership is claimed in SQL immediately before the Meta call.
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
      'id, account_id, task_id, task_target_id, status, message_kind, candidate_text, template_name, template_language, template_params, idempotency_key, local_message_id, whatsapp_message_id',
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
    status: string
    message_kind: 'text' | 'template'
    candidate_text: string | null
    template_name: string | null
    template_language: string | null
    template_params: unknown
    idempotency_key: string
    local_message_id: string | null
    whatsapp_message_id: string | null
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

  const [
    { data: target, error: targetError },
    { data: config, error: configError },
  ] = await Promise.all([
    db
      .from('ai_agent_task_targets')
      .select('contact_id, conversation_id')
      .eq('account_id', row.account_id)
      .eq('task_id', row.task_id)
      .eq('id', row.task_target_id)
      .maybeSingle(),
    db
      .from('whatsapp_config')
      .select('user_id')
      .eq('account_id', row.account_id)
      .maybeSingle(),
  ])

  if (targetError) throw targetError
  if (configError) throw configError

  const targetRow = target as {
    contact_id: string | null
    conversation_id: string | null
  } | null

  if (!targetRow?.contact_id || !targetRow.conversation_id) {
    throw new Error('AGENT_OUTBOUND_TARGET_CONTEXT_MISSING')
  }
  if (!config?.user_id) {
    throw new Error('WHATSAPP_CONFIG_OWNER_MISSING')
  }

  const { data: claimed, error: claimError } = await db.rpc(
    'claim_agent_task_outbound_message',
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

  try {
    let localMessageId: string
    let whatsappMessageId: string

    if (row.message_kind === 'text') {
      if (!row.candidate_text?.trim()) {
        throw new Error('AGENT_OUTBOUND_RESERVED_TEXT_MISSING')
      }

      const sent = await transport.sendText({
        accountId: row.account_id,
        userId: config.user_id,
        conversationId: targetRow.conversation_id,
        contactId: targetRow.contact_id,
        text: row.candidate_text,
        engineIdempotencyKey: row.idempotency_key,
      })
      localMessageId = sent.local_message_id
      whatsappMessageId = sent.whatsapp_message_id
    } else {
      if (!row.template_name || !row.template_language) {
        throw new Error('AGENT_OUTBOUND_RESERVED_TEMPLATE_MISSING')
      }

      const sent = await transport.sendTemplate({
        accountId: row.account_id,
        userId: config.user_id,
        conversationId: targetRow.conversation_id,
        contactId: targetRow.contact_id,
        templateName: row.template_name,
        language: row.template_language,
        params: normalizeTemplateParams(row.template_params),
      })
      whatsappMessageId = sent.whatsapp_message_id

      const { data: localMessage, error: localMessageError } = await db
        .from('messages')
        .select('id')
        .eq('conversation_id', targetRow.conversation_id)
        .eq('message_id', whatsappMessageId)
        .maybeSingle()
      if (localMessageError) throw localMessageError
      if (!localMessage?.id) {
        throw new Error('AGENT_OUTBOUND_TEMPLATE_LOCAL_MESSAGE_MISSING')
      }
      localMessageId = localMessage.id
    }

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
