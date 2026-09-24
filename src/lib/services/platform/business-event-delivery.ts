import { engineSendText } from '@/lib/automations/meta-send'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { createSupabaseTemplateOverrideStore } from '@/lib/messaging/supabase-store'
import type { MessageAudience, MessageChannel } from '@/lib/messaging/types'
import { renderBusinessEventProjection } from './business-event-message-renderer'
import { CURRENT_EVENT_PROJECTOR_REGISTRY } from './composition'

export interface BusinessEventDeliveryProjectionRow {
  id: string
  event_type: string
  event_version: number
  subject_type: string
  subject_id: string
  audience: string
  channel: string
  contact_id: string | null
  conversation_id: string | null
  correlation_id: string | null
  causation_id: string | null
  payload: Record<string, unknown>
  legacy_notification_id: string | null
}

interface ClaimedBusinessEventDeliveryRow
  extends BusinessEventDeliveryProjectionRow {
  attempts: number
  claim_token: string
  dedupe_key: string
}

export interface ActiveBusinessEventDeliveryResult {
  claimed: number
  sent: number
  reconciliation: number
  failed: number
  lastLocalMessageId: string | null
}


export async function renderBusinessEventDeliveryMessage(input: {
  accountId: string
  row: BusinessEventDeliveryProjectionRow
  db?: ReturnType<typeof supabaseAdmin>
}) {
  const db = input.db ?? supabaseAdmin()
  const audience = asMessageAudience(input.row.audience)
  const channel = asMessageChannel(input.row.channel)
  if (!audience || !channel) {
    throw new Error('BUSINESS_EVENT_DELIVERY_SURFACE_UNSUPPORTED')
  }

  const projection = await CURRENT_EVENT_PROJECTOR_REGISTRY.project({
    accountId: input.accountId,
    eventType: input.row.event_type,
    eventVersion: input.row.event_version,
    subjectType: input.row.subject_type,
    subjectId: input.row.subject_id,
    audience,
    channel,
    correlationId: input.row.correlation_id,
    causationId: input.row.causation_id,
    payload: input.row.payload,
  })

  return renderBusinessEventProjection({
    accountId: input.accountId,
    projection,
    store: createSupabaseTemplateOverrideStore(db),
  })
}

export async function renderLinkedLegacyBusinessEventNotification(input: {
  accountId: string
  legacyNotificationId: string
  db?: ReturnType<typeof supabaseAdmin>
}) {
  const db = input.db ?? supabaseAdmin()
  const { data, error } = await db
    .from('business_event_outbox')
    .select(
      'id, event_type, event_version, subject_type, subject_id, audience, channel, contact_id, conversation_id, correlation_id, causation_id, payload, legacy_notification_id',
    )
    .eq('account_id', input.accountId)
    .eq('legacy_notification_id', input.legacyNotificationId)
    .order('created_at', { ascending: true })
    .limit(2)
  if (error) throw error

  const rows = (data ?? []) as BusinessEventDeliveryProjectionRow[]
  if (rows.length === 0) return null
  if (rows.length > 1) {
    throw new Error('LEGACY_NOTIFICATION_BUSINESS_EVENT_AMBIGUOUS')
  }

  return renderBusinessEventDeliveryMessage({
    accountId: input.accountId,
    row: rows[0],
    db,
  })
}

/**
 * Preserve the historical transport idempotency boundary when a general
 * business-event row is strangler-linked to the legacy outbox. This is the
 * second line of duplicate-send defense after the DB routing gate.
 */
export function businessEventEngineIdempotencyKey(input: {
  eventId: string
  legacyNotificationId?: string | null
}): string {
  return input.legacyNotificationId
    ? `customer-intent-notification:${input.legacyNotificationId}`
    : `business-event-outbox:${input.eventId}`
}

/**
 * Generic active customer/WhatsApp delivery.
 *
 * Domain knowledge stops at the EventProjectorRegistry. This worker does not
 * branch on domain names or source-table identifiers.
 */
export async function deliverActiveBusinessEventNotifications(input: {
  accountId: string
  userId: string
  correlationId?: string | null
  subjectType?: string | null
  subjectId?: string | null
  limit?: number
}): Promise<ActiveBusinessEventDeliveryResult> {
  const db = supabaseAdmin()
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
  if ((input.subjectType == null) !== (input.subjectId == null)) {
    throw new Error('BUSINESS_EVENT_SUBJECT_FILTER_INCOMPLETE')
  }

  const { data, error } = await db.rpc('claim_business_event_delivery_v2', {
    p_account_id: input.accountId,
    p_correlation_id: input.correlationId ?? null,
    p_subject_type: input.subjectType ?? null,
    p_subject_id: input.subjectId ?? null,
    p_limit: limit,
  })
  if (error) throw error

  const rows = (data ?? []) as ClaimedBusinessEventDeliveryRow[]
  if (rows.length === 0) {
    return {
      claimed: 0,
      sent: 0,
      reconciliation: 0,
      failed: 0,
      lastLocalMessageId: null,
    }
  }

  let sent = 0
  let reconciliation = 0
  let failed = 0
  let lastLocalMessageId: string | null = null

  for (const row of rows) {
    const engineKey = businessEventEngineIdempotencyKey({
      eventId: row.id,
      legacyNotificationId: row.legacy_notification_id,
    })

    try {
      if (!row.contact_id) throw new Error('BUSINESS_EVENT_CONTACT_MISSING')
      if (!row.conversation_id) throw new Error('BUSINESS_EVENT_CONVERSATION_MISSING')

      const rendered = await renderBusinessEventDeliveryMessage({
        accountId: input.accountId,
        row,
        db,
      })

      const delivered = await engineSendText({
        accountId: input.accountId,
        userId: input.userId,
        conversationId: row.conversation_id,
        contactId: row.contact_id,
        text: rendered.text,
        engineIdempotencyKey: engineKey,
      })

      const { data: updated, error: updateError } = await db
        .from('business_event_outbox')
        .update({
          status: 'sent',
          local_message_id: delivered.local_message_id,
          sent_at: new Date().toISOString(),
          last_error: null,
          claim_token: null,
        })
        .eq('account_id', input.accountId)
        .eq('id', row.id)
        .eq('claim_token', row.claim_token)
        .select('id')
        .maybeSingle()
      if (updateError) throw updateError
      if (!updated) throw new Error('BUSINESS_EVENT_DELIVERY_CLAIM_LOST')

      if (row.legacy_notification_id) {
        const { error: legacySyncError } = await db
          .from('customer_intent_notifications')
          .update({
            status: 'sent',
            local_message_id: delivered.local_message_id,
            sent_at: new Date().toISOString(),
            last_error: null,
            claim_token: null,
          })
          .eq('account_id', input.accountId)
          .eq('id', row.legacy_notification_id)
        if (legacySyncError) {
          // Transport idempotency still prevents a rollback/resume duplicate.
          console.error(
            `[business event delivery] legacy sent-state sync failed event=${row.id.slice(0, 8)}:`,
            legacySyncError,
          )
        }
      }

      sent += 1
      lastLocalMessageId = delivered.local_message_id
      console.info(
        `[business event delivery] sent ${row.event_type}@${row.event_version} event=${row.id.slice(0, 8)}`,
      )
    } catch (deliveryError) {
      const message =
        deliveryError instanceof Error ? deliveryError.message : String(deliveryError)
      const { data: reservation } = await db
        .from('messages')
        .select('id, message_id, status')
        .eq('engine_idempotency_key', engineKey)
        .maybeSingle()

      const requiresReconciliation = Boolean(reservation)
      if (requiresReconciliation) reconciliation += 1
      else failed += 1

      const { error: stateError } = await db
        .from('business_event_outbox')
        .update({
          status: requiresReconciliation ? 'requires_reconciliation' : 'failed',
          local_message_id: reservation?.id ?? null,
          last_error: message.slice(0, 1000),
          claim_token: null,
        })
        .eq('account_id', input.accountId)
        .eq('id', row.id)
        .eq('claim_token', row.claim_token)
      if (stateError) {
        console.error(
          `[business event delivery] failed to persist delivery state event=${row.id.slice(0, 8)}:`,
          stateError,
        )
      }

      console.error(
        `[business event delivery] ${row.event_type}@${row.event_version} event=${row.id.slice(0, 8)} ${requiresReconciliation ? 'requires reconciliation' : 'failed'}:`,
        deliveryError,
      )
    }
  }

  return {
    claimed: rows.length,
    sent,
    reconciliation,
    failed,
    lastLocalMessageId,
  }
}

function asMessageAudience(value: string | null): MessageAudience | null {
  return value === 'customer' || value === 'admin' || value === 'internal'
    ? value
    : null
}

function asMessageChannel(value: string | null): MessageChannel | null {
  return value === 'whatsapp' ||
    value === 'in_app' ||
    value === 'email' ||
    value === 'sms'
    ? value
    : null
}
