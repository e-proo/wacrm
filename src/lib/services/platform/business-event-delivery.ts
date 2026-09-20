import { engineSendText } from '@/lib/automations/meta-send'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { createSupabaseTemplateOverrideStore } from '@/lib/messaging/supabase-store'
import type { MessageAudience, MessageChannel } from '@/lib/messaging/types'
import { renderBusinessEventProjection } from './business-event-message-renderer'
import { CURRENT_EVENT_PROJECTOR_REGISTRY } from './composition'

interface ClaimedBusinessEventDeliveryRow {
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
  attempts: number
  claim_token: string
  legacy_notification_id: string | null
  dedupe_key: string
}

export interface ActiveBusinessEventDeliveryResult {
  claimed: number
  sent: number
  reconciliation: number
  failed: number
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
  limit?: number
}): Promise<ActiveBusinessEventDeliveryResult> {
  const db = supabaseAdmin()
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)

  const { data, error } = await db.rpc('claim_business_event_delivery', {
    p_account_id: input.accountId,
    p_correlation_id: input.correlationId ?? null,
    p_limit: limit,
  })
  if (error) throw error

  const rows = (data ?? []) as ClaimedBusinessEventDeliveryRow[]
  if (rows.length === 0) {
    return { claimed: 0, sent: 0, reconciliation: 0, failed: 0 }
  }

  const store = createSupabaseTemplateOverrideStore(db)
  let sent = 0
  let reconciliation = 0
  let failed = 0

  for (const row of rows) {
    const engineKey = businessEventEngineIdempotencyKey({
      eventId: row.id,
      legacyNotificationId: row.legacy_notification_id,
    })

    try {
      const audience = asMessageAudience(row.audience)
      const channel = asMessageChannel(row.channel)
      if (!audience || !channel) {
        throw new Error('BUSINESS_EVENT_DELIVERY_SURFACE_UNSUPPORTED')
      }
      if (!row.contact_id) throw new Error('BUSINESS_EVENT_CONTACT_MISSING')
      if (!row.conversation_id) throw new Error('BUSINESS_EVENT_CONVERSATION_MISSING')

      const projection = await CURRENT_EVENT_PROJECTOR_REGISTRY.project({
        accountId: input.accountId,
        eventType: row.event_type,
        eventVersion: row.event_version,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        audience,
        channel,
        correlationId: row.correlation_id,
        causationId: row.causation_id,
        payload: row.payload,
      })

      const rendered = await renderBusinessEventProjection({
        accountId: input.accountId,
        projection,
        store,
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
