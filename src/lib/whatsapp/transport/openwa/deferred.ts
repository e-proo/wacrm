import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedInbound, NormalizedInboundMessage, NormalizedInboundMedia } from '@/lib/whatsapp/inbound-normalization'
import type { NormalizedWhatsAppStatus } from '@/lib/whatsapp/status-lifecycle'
import { resolveOpenWAInboundContactIdentity } from './contact-identity'
import { hydrateOpenWAInboundSenderPhone } from './sender-phone'
import { WhatsAppTransportError } from '../types'

const NATIVE_LID = /^[0-9]{5,20}@lid$/
const MAX_PAYLOAD_BYTES = 65_536

/** Only an authenticated, consistently identified @lid chat is eligible for
 * durable recovery. Suspicious JID mismatches are NEVER deferred. */
export function isUnresolvedOpenWALidCandidate(message: NormalizedInboundMessage): boolean {
  const chat = message.providerChatId
  return message.provider === 'openwa' && !!chat && NATIVE_LID.test(chat)
    && (message.from === chat || message.from === chat.slice(0, -4))
}

/**
 * Check identity BEFORE any CRM contact or agent side effect. The same
 * provider-neutral processor handles the message after verification.
 * A temporary gateway failure is not mistaken for "no phone"; historical
 * native mappings may still prove the identity.
 */
export async function preflightOpenWAInboundIdentity(
  db: SupabaseClient,
  input: { accountId: string; connectionId: string; sessionId: string; inbound: NormalizedInbound },
): Promise<'ready' | 'unresolved'> {
  const { accountId, connectionId, sessionId, inbound } = input
  const candidate = isUnresolvedOpenWALidCandidate(inbound.message)
  if (candidate) {
    try {
      await hydrateOpenWAInboundSenderPhone(db, { accountId, connectionId, sessionId, inbound })
    } catch (error) {
      // Gateway outages may be durably deferred, but misconfigured credentials,
      // forbidden sessions and malformed routes must be fixed, not disguised.
      if (!(error instanceof WhatsAppTransportError) ||
          error.code !== 'retryable_provider_failure') throw error
    }
  }
  try {
    await resolveOpenWAInboundContactIdentity(db, {
      accountId, connectionId, sender: inbound.message.from,
      providerChatId: inbound.message.providerChatId,
    })
    return 'ready'
  } catch (error) {
    if (candidate && error instanceof WhatsAppTransportError &&
        error.code === 'connection_restricted') return 'unresolved'
    throw error
  }
}

function safeMedia(value: NormalizedInboundMedia | undefined): NormalizedInboundMedia | undefined {
  if (!value) return undefined
  return {
    id: value.id, mime_type: value.mime_type,
    ...(value.chat_id ? { chat_id: value.chat_id } : {}),
    ...(value.caption ? { caption: value.caption } : {}),
    ...(value.filename ? { filename: value.filename } : {}),
    ...(typeof value.file_size === 'number' ? { file_size: value.file_size } : {}),
  }
}

/** Minimal normalized business input; no raw webhook or base64 media bytes. */
export function compactOpenWAInbound(inbound: NormalizedInbound): NormalizedInbound {
  const m = inbound.message
  const message: NormalizedInboundMessage = {
    id: m.id, provider: 'openwa', connectionId: m.connectionId,
    providerMessageId: m.providerMessageId,
    ...(m.providerEventId ? { providerEventId: m.providerEventId } : {}),
    ...(m.providerChatId ? { providerChatId: m.providerChatId } : {}),
    from: m.from, timestamp: m.timestamp, type: m.type,
    ...(m.recipient ? { recipient: m.recipient } : {}),
    ...(m.text ? { text: { body: m.text.body } } : {}),
    ...(m.image ? { image: safeMedia(m.image) } : {}),
    ...(m.video ? { video: safeMedia(m.video) } : {}),
    ...(m.audio ? { audio: safeMedia(m.audio) } : {}),
    ...(m.document ? { document: safeMedia(m.document) } : {}),
    ...(m.context ? { context: { id: m.context.id } } : {}),
    ...(m.reaction ? { reaction: { ...m.reaction } } : {}),
    ...(m.interactive ? { interactive: { ...m.interactive } } : {}),
    ...(m.button ? { button: { ...m.button } } : {}),
    ...(m.location ? { location: { ...m.location } } : {}),
    ...(m.sticker ? { sticker: { ...m.sticker } } : {}),
  }
  const compact: NormalizedInbound = {
    message,
    contact: { wa_id: inbound.contact.wa_id, profile: { name: inbound.contact.profile.name } },
  }
  if (new TextEncoder().encode(JSON.stringify(compact)).length > MAX_PAYLOAD_BYTES) {
    throw new Error('OpenWA normalized inbound exceeds bounded durable payload')
  }
  return compact
}

export async function deferOpenWAWebhook(
  db: SupabaseClient,
  input: {
    accountId: string; connectionId: string; sessionId: string
    providerEventId: string; providerMessageId: string; processingToken: string
    deferred: { kind: 'unresolved_identity'; inbound: NormalizedInbound }
      | { kind: 'unmatched_status'; status: Omit<NormalizedWhatsAppStatus, 'provider' | 'accountId' | 'connectionId' | 'providerMessageId'> }
  },
): Promise<void> {
  const { deferred } = input
  if (deferred.kind === 'unresolved_identity' && !isUnresolvedOpenWALidCandidate(deferred.inbound.message)) {
    throw new Error('Only verified unresolved native LIDs may enter the deferred inbound queue')
  }
  const payload = deferred.kind === 'unresolved_identity'
    ? compactOpenWAInbound(deferred.inbound) : {
        status: deferred.status.status,
        ...(deferred.status.timestamp ? { timestamp: deferred.status.timestamp } : {}),
      }
  const native = deferred.kind === 'unresolved_identity'
    ? deferred.inbound.message.providerChatId ?? null : null
  const { data, error } = await db.rpc('defer_openwa_webhook_event', {
    p_account_id: input.accountId,
    p_connection_id: input.connectionId,
    p_session_id: input.sessionId,
    p_event_id: input.providerEventId,
    p_provider_message_id: input.providerMessageId,
    p_event_kind: deferred.kind,
    p_native_chat_id: native,
    p_payload: payload,
    p_processing_token: input.processingToken,
  })
  if (error || data !== true) throw new Error('OpenWA durable event reservation could not be committed')
}

/** Validate the subset persisted by our own service-only queue. Never trust
 * arbitrary JSONB fields as a phone or as an authorization grant. */
export function readDeferredInbound(value: unknown, connectionId: string, providerId: string, chat: string): NormalizedInbound | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const message = row.message
  const contact = row.contact
  if (!message || typeof message !== 'object' || Array.isArray(message) ||
      !contact || typeof contact !== 'object' || Array.isArray(contact)) return null
  const m = message as Record<string, unknown>
  const c = contact as Record<string, unknown>
  if (m.provider !== 'openwa' || m.connectionId !== connectionId ||
      m.providerMessageId !== providerId || m.providerChatId !== chat ||
      !isUnresolvedOpenWALidCandidate(m as unknown as NormalizedInboundMessage)) return null
  const profile = c.profile as Record<string, unknown> | null
  if (!profile || typeof profile.name !== 'string' || typeof c.wa_id !== 'string' ||
      c.wa_id !== m.from || typeof m.timestamp !== 'string' ||
      typeof m.type !== 'string' || typeof m.id !== 'string') return null
  return { message: m as unknown as NormalizedInboundMessage,
    contact: { wa_id: c.wa_id, profile: { name: profile.name } } }
}

export function readDeferredStatus(value: unknown): { status: 'sent' | 'delivered' | 'read' | 'failed'; timestamp?: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (!['sent','delivered','read','failed'].includes(String(row.status))) return null
  return { status: row.status as 'sent' | 'delivered' | 'read' | 'failed',
    ...(typeof row.timestamp === 'string' ? { timestamp: row.timestamp } : {}) }
}
