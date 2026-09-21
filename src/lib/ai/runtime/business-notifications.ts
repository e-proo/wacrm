import { supabaseAdmin } from '@/lib/ai/admin-client'
import { renderPendingChangeRequestAdminMessage } from '@/lib/messaging/change-request-admin'
import { createSupabaseTemplateOverrideStore } from '@/lib/messaging/supabase-store'
import { sendTextMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  isRecipientNotAllowedError,
  phoneVariants,
  sanitizePhoneForMeta,
} from '@/lib/whatsapp/phone-utils'

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

interface WhatsappRuntimeConfig {
  phone_number_id: string
  access_token: string
}

/**
 * Notify verified administrators that a human decision is waiting.
 *
 * The durable dashboard notification deliberately excludes the one-time PIN.
 * The PIN is supplied to the messaging renderer only as a transient secret and
 * the secret-bearing WhatsApp body is sent through the direct Meta transport,
 * never through engineSendText / the persisted CRM messages table.
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
  // the fallback that survives a WhatsApp-window/provider failure. It never
  // contains the plaintext approval code.
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
      console.error(
        `[change request notification] CHG-${input.requestCode} in-app notification failed:`,
        notificationError,
      )
    } else {
      inAppCreated = inserted?.length ?? 0
    }
  }

  // An idempotent create-change replay intentionally receives no plaintext PIN
  // from the database. Never fabricate/recover one and never resend the approval
  // WhatsApp body without that one-time secret.
  if (!input.confirmationCode) {
    console.info(
      `[change request notification] CHG-${input.requestCode} replay: no approval PIN re-sent`,
    )
    return { eligible: eligible.length, whatsappSent: 0, inAppCreated }
  }

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (configError || !config?.phone_number_id || !config.access_token) {
    console.error(
      `[change request notification] CHG-${input.requestCode} WhatsApp config unavailable:`,
      configError?.message ?? 'missing WhatsApp configuration',
    )
    return { eligible: eligible.length, whatsappSent: 0, inAppCreated }
  }
  const whatsappConfig = config as WhatsappRuntimeConfig

  const rendered = await renderPendingChangeRequestAdminMessage({
    accountId: input.accountId,
    changeRequestId: input.changeRequestId,
    requestCode: input.requestCode,
    confirmationCode: input.confirmationCode,
    summary: input.summary,
    targetType: input.targetType,
    proposedPayload: input.proposedPayload,
    store: createSupabaseTemplateOverrideStore(db),
  })

  console.info(
    [
      '[messaging] event=change_request.pending',
      `source=${rendered.source}`,
      `template=${rendered.resolvedEventKey}`,
      `locale=${rendered.resolvedLocale}`,
      'channel=whatsapp',
      rendered.revisionId ? `revision=${rendered.revisionId}` : null,
      rendered.version != null ? `version=${rendered.version}` : null,
      rendered.fallbackReason ? `fallback=${rendered.fallbackReason}` : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' '),
  )

  // Security boundary: the rendered text contains the one-time PIN. Always use
  // direct Meta transport here so the plaintext secret is not persisted in the
  // CRM messages table. Durable in-app metadata above remains PIN-free.
  let whatsappSent = 0
  for (const identity of eligible) {
    try {
      await sendDirectTrustedAdminText({
        config: whatsappConfig,
        normalizedAddress: identity.normalized_address,
        text: rendered.text,
      })
      whatsappSent += 1
      console.info(
        `[change request notification] CHG-${input.requestCode} sent to trusted admin ${identity.id.slice(0, 8)} via direct WhatsApp transport`,
      )
    } catch (sendError) {
      // A free-form WhatsApp send can be unavailable outside Meta's customer
      // service window. The pending CR + PIN-free in-app notification remain.
      console.error(
        `[change request notification] CHG-${input.requestCode} WhatsApp alert failed for ${identity.id.slice(0, 8)}:`,
        sendError,
      )
    }
  }

  return { eligible: eligible.length, whatsappSent, inAppCreated }
}

async function sendDirectTrustedAdminText(input: {
  config: WhatsappRuntimeConfig
  normalizedAddress: string
  text: string
}): Promise<void> {
  const phone = sanitizePhoneForMeta(input.normalizedAddress)
  const accessToken = decrypt(input.config.access_token)
  let lastError: unknown = null

  for (const candidate of phoneVariants(phone)) {
    try {
      await sendTextMessage({
        phoneNumberId: input.config.phone_number_id,
        accessToken,
        to: candidate,
        text: input.text,
      })
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!isRecipientNotAllowedError(message)) throw error
      lastError = error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Could not deliver trusted-admin approval alert')
}
