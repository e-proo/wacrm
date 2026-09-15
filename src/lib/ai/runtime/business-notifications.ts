import { randomUUID } from 'node:crypto'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { engineSendText } from '@/lib/automations/meta-send'
import { findExistingContact } from '@/lib/contacts/dedupe'

const APPROVAL_CAPABILITY = 'change_requests.approve'

interface AdminChangeNotificationInput {
  accountId: string
  changeRequestId: string
  requestCode: number
  confirmationCode: string | null
  summary: string | null
  targetType: string
  proposedPayload: Record<string, unknown>
}

interface TrustedIdentityRow {
  id: string
  normalized_address: string
  display_name: string | null
  member_id: string | null
  allowed_capabilities: unknown
}

/**
 * Notify verified administrators that a human decision is waiting.
 *
 * The durable CRM notification deliberately excludes the one-time PIN. The
 * plaintext PIN is never persisted outside the create_change_request_v2 RPC
 * response; when present, it is delivered directly to a verified WhatsApp
 * identity and then discarded by the caller/model boundary.
 */
export async function notifyTrustedAdminsOfChangeRequest(
  input: AdminChangeNotificationInput,
): Promise<{ eligible: number; whatsappSent: number; inAppCreated: number }> {
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('trusted_admin_identities')
    .select('id, normalized_address, display_name, member_id, allowed_capabilities')
    .eq('account_id', input.accountId)
    .eq('channel', 'whatsapp')
    .eq('status', 'active')
    .is('revoked_at', null)

  if (error) throw error

  const eligible = ((data ?? []) as TrustedIdentityRow[]).filter((identity) =>
    Array.isArray(identity.allowed_capabilities) &&
    identity.allowed_capabilities.includes(APPROVAL_CAPABILITY),
  )

  if (eligible.length === 0) {
    console.warn(
      `[change request notification] CHG-${input.requestCode} has no active trusted admin with ${APPROVAL_CAPABILITY}`,
    )
    return { eligible: 0, whatsappSent: 0, inAppCreated: 0 }
  }

  const conversationId =
    typeof input.proposedPayload.conversation_id === 'string'
      ? input.proposedPayload.conversation_id
      : null
  const contactId =
    typeof input.proposedPayload.contact_id === 'string'
      ? input.proposedPayload.contact_id
      : null

  // Durable dashboard/realtime notification for linked human members. This is
  // the fallback that survives a WhatsApp-window/provider failure.
  const linkedMemberIds = [
    ...new Set(
      eligible
        .map((identity) => identity.member_id)
        .filter((memberId): memberId is string => Boolean(memberId)),
    ),
  ]
  let inAppCreated = 0
  if (linkedMemberIds.length > 0) {
    const rows = linkedMemberIds.map((memberId) => ({
      account_id: input.accountId,
      user_id: memberId,
      type: 'change_request_pending',
      conversation_id: conversationId,
      contact_id: contactId,
      actor_user_id: null,
      change_request_id: input.changeRequestId,
      dedupe_key: `change-request:${input.changeRequestId}:member:${memberId}`,
      title: `طلب موافقة جديد CHG-${input.requestCode}`,
      body: input.summary ?? `طلب تغيير جديد من النوع ${input.targetType}`,
    }))
    const { data: inserted, error: notificationError } = await db
      .from('notifications')
      .upsert(rows, { onConflict: 'dedupe_key', ignoreDuplicates: true })
      .select('id')
    if (notificationError) {
      // Migration 072 may not have landed yet during a rolling deploy. Never
      // make the business proposal fail because its secondary notification did.
      console.error(
        `[change request notification] CHG-${input.requestCode} in-app notification failed:`,
        notificationError,
      )
    } else {
      inAppCreated = inserted?.length ?? 0
    }
  }

  // An idempotent replay intentionally receives no plaintext PIN from the DB.
  // Do not fabricate/recover one and do not send a second approval message.
  if (!input.confirmationCode) {
    console.info(
      `[change request notification] CHG-${input.requestCode} replay: no approval PIN re-sent`,
    )
    return { eligible: eligible.length, whatsappSent: 0, inAppCreated }
  }

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('user_id')
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (configError || !config?.user_id) {
    console.error(
      `[change request notification] CHG-${input.requestCode} WhatsApp config unavailable:`,
      configError?.message ?? 'missing config owner',
    )
    return { eligible: eligible.length, whatsappSent: 0, inAppCreated }
  }

  const approveCommand = `اعتماد CHG-${input.requestCode} ${input.confirmationCode}`
  const rejectCommand = `رفض CHG-${input.requestCode}`
  const text = [
    '🔔 طلب موافقة جديد',
    `المرجع: CHG-${input.requestCode}`,
    input.summary ? `الملخص: ${input.summary}` : null,
    `النوع: ${input.targetType}`,
    '',
    `للاعتماد: ${approveCommand}`,
    `للرفض: ${rejectCommand}`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n')

  let whatsappSent = 0
  for (const identity of eligible) {
    try {
      const contact = await findExistingContact(
        db,
        input.accountId,
        identity.normalized_address,
      )
      if (!contact) {
        console.warn(
          `[change request notification] CHG-${input.requestCode} trusted admin ${identity.id.slice(0, 8)} has no CRM contact; WhatsApp alert skipped`,
        )
        continue
      }

      const { data: conversation, error: conversationError } = await db
        .from('conversations')
        .select('id')
        .eq('account_id', input.accountId)
        .eq('contact_id', contact.id)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (conversationError) throw conversationError
      if (!conversation?.id) {
        console.warn(
          `[change request notification] CHG-${input.requestCode} trusted admin ${identity.id.slice(0, 8)} has no CRM conversation; WhatsApp alert skipped`,
        )
        continue
      }

      await engineSendText({
        accountId: input.accountId,
        userId: config.user_id,
        conversationId: conversation.id,
        contactId: contact.id,
        text,
        engineIdempotencyKey: `change-request-admin:${input.changeRequestId}:${identity.id}`,
      })
      whatsappSent += 1
      console.info(
        `[change request notification] CHG-${input.requestCode} sent to trusted admin ${identity.id.slice(0, 8)}`,
      )
    } catch (sendError) {
      // A free-form WhatsApp send can be unavailable outside Meta's customer
      // service window. The pending CR + in-app notification remain durable.
      console.error(
        `[change request notification] CHG-${input.requestCode} WhatsApp alert failed for ${identity.id.slice(0, 8)}:`,
        sendError,
      )
    }
  }

  return { eligible: eligible.length, whatsappSent, inAppCreated }
}

interface CustomerNotificationRow {
  id: string
  contact_id: string
  conversation_id: string | null
  message_text: string
  attempts: number
}

/**
 * Drain customer_intent_notifications after a deterministic admin decision.
 * A local message idempotency reservation is created before Meta is called by
 * engineSendText, so this sender never blindly duplicates an uncertain send.
 */
export async function deliverPendingCustomerIntentNotifications(input: {
  accountId: string
  changeRequestId?: string | null
  limit?: number
}): Promise<{ claimed: number; sent: number; reconciliation: number; failed: number }> {
  const db = supabaseAdmin()
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
  let query = db
    .from('customer_intent_notifications')
    .select('id, contact_id, conversation_id, message_text, attempts')
    .eq('account_id', input.accountId)
    .eq('status', 'pending')
    .lte('available_at', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(limit)
  if (input.changeRequestId) {
    query = query.eq('change_request_id', input.changeRequestId)
  }

  const { data, error } = await query
  if (error) throw error

  const rows = (data ?? []) as CustomerNotificationRow[]
  if (rows.length === 0) {
    return { claimed: 0, sent: 0, reconciliation: 0, failed: 0 }
  }

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('user_id')
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (configError || !config?.user_id) {
    throw configError ?? new Error('WHATSAPP_CONFIG_OWNER_MISSING')
  }

  let claimedCount = 0
  let sentCount = 0
  let reconciliationCount = 0
  let failedCount = 0

  for (const row of rows) {
    const claimToken = randomUUID()
    const { data: claimed, error: claimError } = await db
      .from('customer_intent_notifications')
      .update({
        status: 'sending',
        claim_token: claimToken,
        claimed_at: new Date().toISOString(),
        attempts: row.attempts + 1,
        last_error: null,
      })
      .eq('id', row.id)
      .eq('account_id', input.accountId)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (claimError) {
      console.error('[customer notification] claim failed:', claimError)
      continue
    }
    if (!claimed) continue
    claimedCount += 1

    if (!row.conversation_id) {
      failedCount += 1
      await db
        .from('customer_intent_notifications')
        .update({ status: 'failed', last_error: 'CONVERSATION_MISSING' })
        .eq('id', row.id)
        .eq('claim_token', claimToken)
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
        .eq('claim_token', claimToken)
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
        .eq('claim_token', claimToken)

      console.error(
        `[customer notification] ${row.id.slice(0, 8)} ${requiresReconciliation ? 'requires reconciliation' : 'failed'}:`,
        sendError,
      )
    }
  }

  return {
    claimed: claimedCount,
    sent: sentCount,
    reconciliation: reconciliationCount,
    failed: failedCount,
  }
}
