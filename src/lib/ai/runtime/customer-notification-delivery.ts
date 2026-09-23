import { supabaseAdmin } from '../admin-client'
import { engineSendText } from '@/lib/automations/meta-send'
import { CURRENT_LEGACY_NOTIFICATION_RENDERERS } from '@/lib/services/platform/legacy-notification-composition'
import { deliverActiveBusinessEventNotifications } from '@/lib/services/platform/business-event-delivery'

interface ClaimedCustomerNotificationRow {
  id: string
  contact_id: string
  conversation_id: string | null
  message_text: string
  attempts: number
  claim_token: string
  intent_id: string | null
  event_type: string
  change_request_id: string | null
}


interface WhatsAppDeliveryOwner {
  user_id: string
}

async function loadWhatsAppDeliveryOwner(
  accountId: string,
): Promise<WhatsAppDeliveryOwner> {
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('user_id')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw error
  if (!data?.user_id) throw new Error('WHATSAPP_CONFIG_OWNER_MISSING')
  return { user_id: data.user_id }
}

export async function deliverActiveSubjectBusinessEventNotifications(input: {
  accountId: string
  subjectType: string
  subjectId: string
  correlationId?: string | null
  limit?: number
}): Promise<{ claimed: number; sent: number; reconciliation: number; failed: number }> {
  const owner = await loadWhatsAppDeliveryOwner(input.accountId)
  return deliverActiveBusinessEventNotifications({
    accountId: input.accountId,
    userId: owner.user_id,
    correlationId: input.correlationId ?? null,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    limit: input.limit,
  })
}


/**
 * Deliver due customer business-event notifications using the same durable
 * outbox for service intents, coverage outcomes, and FX V2 trade lifecycle
 * events. Eligibility is evaluated with the database clock and SKIP LOCKED
 * prevents concurrent senders from claiming the same event.
 *
 * Customer-facing text is rendered from authoritative business state at
 * delivery time. Domain-specific legacy rollback renderers are isolated behind
 * a temporary adapter registry; the runtime kernel contains no FX/Coverage
 * rendering branch. New delivery uses the canonical Business Event path.
 */
export async function deliverCustomerOutcomeNotifications(input: {
  accountId: string
  changeRequestId?: string | null
  limit?: number
}): Promise<{ claimed: number; sent: number; reconciliation: number; failed: number }> {
  const db = supabaseAdmin()
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)

  // Check transport ownership before claiming rows so a configuration failure
  // never strands notifications in `sending`.
  const config = await loadWhatsAppDeliveryOwner(input.accountId)

  const activeDelivery = await deliverActiveBusinessEventNotifications({
    accountId: input.accountId,
    userId: config.user_id,
    correlationId: input.changeRequestId ?? null,
    limit,
  })

  const remaining = limit - activeDelivery.claimed
  if (remaining <= 0) {
    return activeDelivery
  }

  const { data, error } = await db.rpc('claim_customer_business_notifications', {
    p_account_id: input.accountId,
    p_change_request_id: input.changeRequestId ?? null,
    p_limit: remaining,
  })
  if (error) throw error

  const rows = (data ?? []) as ClaimedCustomerNotificationRow[]
  if (rows.length === 0) {
    return activeDelivery
  }

  let sentCount = activeDelivery.sent
  let reconciliationCount = activeDelivery.reconciliation
  let failedCount = activeDelivery.failed

  for (const row of rows) {
    if (!row.conversation_id) {
      failedCount += 1
      await db
        .from('customer_intent_notifications')
        .update({ status: 'failed', last_error: 'CONVERSATION_MISSING' })
        .eq('id', row.id)
        .eq('claim_token', row.claim_token)
      continue
    }

    // Keep the historical key prefix so already-reserved service-intent sends
    // remain idempotent across this migration to the unified business outbox.
    const engineKey = `customer-intent-notification:${row.id}`
    try {
      const text = await resolveCustomerOutcomeText({
        accountId: input.accountId,
        row,
        fallbackText: row.message_text,
      })
      const sent = await engineSendText({
        accountId: input.accountId,
        userId: config.user_id,
        conversationId: row.conversation_id,
        contactId: row.contact_id,
        text,
        engineIdempotencyKey: engineKey,
      })

      const { error: sentUpdateError } = await db
        .from('customer_intent_notifications')
        .update({
          status: 'sent',
          local_message_id: sent.local_message_id,
          sent_at: new Date().toISOString(),
          last_error: null,
          claim_token: null,
        })
        .eq('id', row.id)
        .eq('claim_token', row.claim_token)
      if (sentUpdateError) throw sentUpdateError

      sentCount += 1
      console.info(
        `[customer business event] sent ${row.event_type} notification=${row.id.slice(0, 8)} source=legacy_outbox`,
      )
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : String(sendError)
      const { data: localReservation } = await db
        .from('messages')
        .select('id, message_id, status')
        .eq('engine_idempotency_key', engineKey)
        .maybeSingle()

      const requiresReconciliation = Boolean(localReservation)
      if (requiresReconciliation) reconciliationCount += 1
      else failedCount += 1

      await db
        .from('customer_intent_notifications')
        .update({
          status: requiresReconciliation ? 'requires_reconciliation' : 'failed',
          local_message_id: localReservation?.id ?? null,
          last_error: message.slice(0, 1000),
          claim_token: null,
        })
        .eq('id', row.id)
        .eq('claim_token', row.claim_token)

      console.error(
        `[customer business event] ${row.event_type} ${row.id.slice(0, 8)} ${requiresReconciliation ? 'requires reconciliation' : 'failed'}:`,
        sendError,
      )
    }
  }

  return {
    claimed: activeDelivery.claimed + rows.length,
    sent: sentCount,
    reconciliation: reconciliationCount,
    failed: failedCount,
  }
}


async function resolveCustomerOutcomeText(input: {
  accountId: string
  row: ClaimedCustomerNotificationRow
  fallbackText: string
}): Promise<string> {
  const domainRendered = await CURRENT_LEGACY_NOTIFICATION_RENDERERS.render({
    accountId: input.accountId,
    notification: {
      id: input.row.id,
      intentId: input.row.intent_id,
      changeRequestId: input.row.change_request_id,
      eventType: input.row.event_type,
    },
  })
  return domainRendered ?? input.fallbackText
}
