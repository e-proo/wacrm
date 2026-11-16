import { supabaseAdmin } from '@/lib/ai/admin-client'
import { renderPendingChangeRequestAdminMessage } from '@/lib/messaging/change-request-admin'
import { createSupabaseTemplateOverrideStore } from '@/lib/messaging/supabase-store'
import { sendTextMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { isSensitiveOpenWAAdminApprovalText } from '@/lib/whatsapp/transport/openwa/admin-approval-echo'
import { resolveWhatsAppTransport } from '@/lib/whatsapp/transport/router'
import { openWAPilotRecipientHash } from '@/lib/whatsapp/transport/guardrails'
import { resolveOpenWAPilotRecipientForGrant } from '@/lib/whatsapp/transport/openwa/pilot-recipient'
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
  /** Unique for a deliberately authorized PIN reissue, never a provider retry. */
  notificationAttemptId?: string
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
  // The account owner is the last-resort dashboard recipient even when the
  // trusted WhatsApp identity has no linked member_id (common in TEST).
  // This fallback never includes the approval PIN.
  const { data: account, error: accountError } = await db.from('accounts')
    .select('owner_user_id').eq('id', input.accountId).maybeSingle()
  if (accountError) throw accountError
  const linkedMemberIds = [
    ...new Set([
      ...eligible.map(identity => identity.member_id),
      account?.owner_user_id ?? null,
    ].filter((memberId): memberId is string => Boolean(memberId))),
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

  // Use the signed inbound's connection for supplier-originated proposals.
  // A source recorded under OpenWA must never silently jump to the legacy
  // Meta sender merely because whatsapp_config still has credentials.
  const sourceMessageId = input.proposedPayload.source_message_id
  const providedConversationId = input.proposedPayload.conversation_id
  let openWAConnectionId: string | null = null
  if (typeof sourceMessageId === 'string' && typeof providedConversationId === 'string') {
    const { data: conversation, error: convError } = await db.from('conversations')
      .select('id').eq('account_id', input.accountId)
      .eq('id', providedConversationId).maybeSingle()
    if (convError) throw convError
    if (!conversation) throw new Error('Change Request source conversation is not in this account')
    const { data: source, error: sourceError } = await db.from('messages')
      .select('provider,connection_id').eq('id', sourceMessageId)
      .eq('conversation_id', conversation.id).maybeSingle()
    if (sourceError) throw sourceError
    if (!source) throw new Error('Change Request source message is unavailable')
    if (source.provider === 'openwa') {
      if (!source.connection_id) throw new Error('Change Request source OpenWA connection is missing')
      openWAConnectionId = source.connection_id
    }
  }

  const rendered = await renderPendingChangeRequestAdminMessage({
    accountId: input.accountId,
    changeRequestId: input.changeRequestId,
    requestCode: input.requestCode,
    confirmationCode: input.confirmationCode,
    summary: input.summary,
    targetType: input.targetType,
    proposedPayload: input.proposedPayload,
    // OpenWA direct sends deliberately use the reviewed fixed system
    // template, whose own-device echo can be safely excluded. An account
    // override could otherwise leak the OTP into CRM message persistence.
    store: openWAConnectionId ? null : createSupabaseTemplateOverrideStore(db),
  })

  console.info(
    [
      '[messaging] event=change_request.pending',
      `source=${rendered.source}`,
      `template=${rendered.resolvedEventKey}`,
      `locale=${rendered.resolvedLocale}`,
      `channel=whatsapp provider=${openWAConnectionId ? 'openwa' : 'meta_cloud'}`,
      rendered.revisionId ? `revision=${rendered.revisionId}` : null,
      rendered.version != null ? `version=${rendered.version}` : null,
      rendered.fallbackReason ? `fallback=${rendered.fallbackReason}` : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' '),
  )

  if (openWAConnectionId) {
    // Fail closed rather than letting an approval PIN leak into the
    // persisted own-device CRM echo if the template contract changes.
    if (!isSensitiveOpenWAAdminApprovalText(rendered.text)) {
      throw new Error('ADMIN_ALERT_OPENWA_SECRET_ECHO_CONTRACT_INVALID')
    }
    let whatsappAccepted = 0
    for (const identity of eligible) {
      try {
        // API workload uses the existing per-session Pilot allowlist,
        // pause/circuit, pacing and bounded capacity. No auto-approval and
        // no fallback to a different sender after an ambiguous outcome.
        const { transport } = await resolveWhatsAppTransport(db, input.accountId, openWAConnectionId)
        const resolvedRecipient = await resolveOpenWAPilotRecipientForGrant(
          db, input.accountId, openWAConnectionId, identity.normalized_address,
        )
        const recipient = resolvedRecipient.recipient
        if (!openWAPilotRecipientHash(input.accountId, openWAConnectionId, recipient)) {
          throw new Error('ADMIN_ALERT_RECIPIENT_INVALID')
        }
        const result = await transport.send({
          accountId: input.accountId,
          connectionId: openWAConnectionId,
          recipient,
          content: { kind: 'text', text: rendered.text },
          workload: 'api',
          idempotencyKey: `admin-alert:${input.changeRequestId}:${identity.id}:${input.notificationAttemptId ?? 'initial'}`,
        })
        if (!result.providerMessageId) throw new Error('ADMIN_ALERT_PROVIDER_ID_MISSING')
        whatsappAccepted += 1
        console.info('[change request notification] provider accepted administrative alert', {
          requestCode: input.requestCode, provider: 'openwa',
          recipientIdentity: identity.id.slice(0, 8),
          delivered: false,
        })
      } catch (sendError) {
        // Never log the PIN-bearing body, gateway credentials or arbitrary
        // provider errors. An uncertain send MUST NOT be retried blindly.
        const code = sendError && typeof sendError === 'object' && 'code' in sendError
          ? String((sendError as { code: unknown }).code) : 'unavailable'
        console.warn('[change request notification] admin OpenWA alert not confirmed', {
          requestCode: input.requestCode, identity: identity.id.slice(0, 8),
          provider: 'openwa', code,
        })
      }
    }
    return { eligible: eligible.length, whatsappSent: whatsappAccepted, inAppCreated }
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
        `[change request notification] CHG-${input.requestCode} accepted by Meta API for trusted admin ${identity.id.slice(0, 8)} (delivery unconfirmed)`,
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


/**
 * Check the selected provider and the trusted-admin API Pilot grant BEFORE
 * issuing a replacement PIN. On denial no secret is rotated or dispatched.
 * No fallback between senders and no admission mutation during preflight.
 */
export async function assertTrustedAdminAlertResendReady(
  accountId: string,
  proposedPayload: Record<string, unknown>,
): Promise<void> {
  const db = supabaseAdmin()
  const { data: trusted, error: te } = await db.from('trusted_admin_identities')
    .select('id,normalized_address,allowed_capabilities,verified_at')
    .eq('account_id', accountId).eq('channel', 'whatsapp')
    .eq('status', 'active').is('revoked_at', null)
  if (te) throw te
  const eligible = (trusted ?? []).filter(t => t.verified_at &&
    Array.isArray(t.allowed_capabilities) &&
    t.allowed_capabilities.includes(APPROVAL_CAPABILITY))
  if (!eligible.length) throw new Error('ADMIN_ALERT_NO_VERIFIED_APPROVER')

  const sourceId = proposedPayload.source_message_id
  const conversationId = proposedPayload.conversation_id
  if (typeof sourceId === 'string' && typeof conversationId === 'string') {
    const { data: conv, error: ce } = await db.from('conversations')
      .select('id').eq('account_id', accountId).eq('id', conversationId).maybeSingle()
    if (ce || !conv) throw new Error('ADMIN_ALERT_INVALID_SOURCE')
    const { data: source, error: se } = await db.from('messages')
      .select('provider,connection_id').eq('id', sourceId)
      .eq('conversation_id', conversationId).maybeSingle()
    if (se || !source) throw new Error('ADMIN_ALERT_INVALID_SOURCE')
    if (source.provider === 'openwa') {
      const connectionId = source.connection_id
      if (!connectionId) throw new Error('ADMIN_ALERT_OPENWA_CONNECTION_UNAVAILABLE')
      const { data: connection, error: connectionError } = await db.from('whatsapp_connections')
        .select('status').eq('account_id', accountId).eq('id', connectionId)
        .eq('provider', 'openwa').is('archived_at', null).maybeSingle()
      if (connectionError || !connection || !['ready','connected'].includes(connection.status)) {
        throw new Error('ADMIN_ALERT_OPENWA_CONNECTION_UNAVAILABLE')
      }
      const { data: guard, error: guardError } = await db.from('whatsapp_connection_guardrails')
        .select('pilot_enabled,manual_paused,circuit_open_until')
        .eq('account_id', accountId).eq('connection_id', connectionId).maybeSingle()
      if (guardError || !guard || guard.pilot_enabled !== true ||
          guard.manual_paused !== false || guard.circuit_open_until != null) {
        throw new Error('ADMIN_ALERT_PILOT_PAUSED')
      }
      for (const identity of eligible) {
        const resolved = await resolveOpenWAPilotRecipientForGrant(
          db, accountId, connectionId, identity.normalized_address,
        )
        const hash = openWAPilotRecipientHash(accountId, connectionId, resolved.recipient)
        if (!hash) continue
        const { data: grant, error: ge } = await db.from('whatsapp_openwa_pilot_allowlist')
          .select('id').eq('account_id', accountId).eq('connection_id', connectionId)
          .eq('workload', 'api').eq('recipient_hash', hash)
          .eq('active', true).gt('expires_at', new Date().toISOString()).maybeSingle()
        if (ge) throw ge
        if (grant) return
      }
      throw new Error('ADMIN_ALERT_PILOT_API_NOT_APPROVED')
    }
  }

  const { data: config, error: configError } = await db.from('whatsapp_config')
    .select('phone_number_id,access_token').eq('account_id', accountId).maybeSingle()
  if (configError || !config?.phone_number_id || !config.access_token) {
    throw new Error('ADMIN_ALERT_META_CONFIGURATION_MISSING')
  }
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
