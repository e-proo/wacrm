import { supabaseAdmin } from '../admin-client'
import { engineSendText } from '@/lib/automations/meta-send'

interface ClaimedCustomerNotificationRow {
  id: string
  contact_id: string
  conversation_id: string | null
  message_text: string
  attempts: number
  claim_token: string
}

/**
 * Deliver due customer outcome notifications using an atomic PostgreSQL claim.
 * Eligibility is evaluated with the database clock, avoiding app/DB clock skew,
 * and SKIP LOCKED prevents concurrent workers from claiming the same row.
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
  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('user_id')
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (configError || !config?.user_id) {
    throw configError ?? new Error('WHATSAPP_CONFIG_OWNER_MISSING')
  }

  const { data, error } = await db.rpc('claim_customer_intent_notifications', {
    p_account_id: input.accountId,
    p_change_request_id: input.changeRequestId ?? null,
    p_limit: limit,
  })
  if (error) throw error

  const rows = (data ?? []) as ClaimedCustomerNotificationRow[]
  if (rows.length === 0) {
    return { claimed: 0, sent: 0, reconciliation: 0, failed: 0 }
  }

  let sentCount = 0
  let reconciliationCount = 0
  let failedCount = 0

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

    const engineKey = `customer-intent-notification:${row.id}`
    try {
      const sent = await engineSendText({
        accountId: input.accountId,
        userId: config.user_id,
        conversationId: row.conversation_id,
        contactId: row.contact_id,
        text: row.message_text,
        engineIdempotencyKey: engineKey,
      })

      const { error: sentUpdateError } = await db
        .from('customer_intent_notifications')
        .update({
          status: 'sent',
          local_message_id: sent.local_message_id,
          sent_at: new Date().toISOString(),
          last_error: null,
        })
        .eq('id', row.id)
        .eq('claim_token', row.claim_token)
      if (sentUpdateError) throw sentUpdateError

      sentCount += 1
      console.info(`[customer notification] sent ${row.id.slice(0, 8)}`)
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
        })
        .eq('id', row.id)
        .eq('claim_token', row.claim_token)

      console.error(
        `[customer notification] ${row.id.slice(0, 8)} ${requiresReconciliation ? 'requires reconciliation' : 'failed'}:`,
        sendError,
      )
    }
  }

  return {
    claimed: rows.length,
    sent: sentCount,
    reconciliation: reconciliationCount,
    failed: failedCount,
  }
}
