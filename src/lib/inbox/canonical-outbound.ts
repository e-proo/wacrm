import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedInbound, NormalizedInboundMessage } from '@/lib/whatsapp/inbound-normalization'
import type { NormalizedWhatsAppStatus } from '@/lib/whatsapp/status-lifecycle'
import type { MirrorStorage } from '@/lib/whatsapp/mirror-inbound-media'
import { findOrCreateContact, findOrCreateConversation } from '@/lib/whatsapp/inbound-processor'
import { hydrateOpenWAInboundSenderPhone } from '@/lib/whatsapp/transport/openwa/sender-phone'
import { hydrateOpenWAInboundMessageMedia } from '@/lib/whatsapp/transport/openwa/inbound-media'
import { canonicalReviewPayload, holdCanonicalReview, type CanonicalReceipt } from './canonical-ingress'
export async function reconcileCanonicalEcho(input: { db: SupabaseClient; storage: MirrorStorage; accountId: string; ownerUserId: string; message: NormalizedInboundMessage; receipt: CanonicalReceipt; signedInlineMedia?: string }) {
  const { db, storage, accountId, ownerUserId, receipt, signedInlineMedia, message } = input
  const chat = message.providerChatId
  if (message.provider !== 'openwa' || message.providerEventId !== receipt.eventId || message.providerMetadata?.sessionId !== receipt.sessionId || (message.providerMetadata?.instanceId ?? null) !== receipt.instanceId) throw new Error('Canonical echo binding mismatch')
  const hold = () => holdCanonicalReview(db, accountId, message, receipt, 'outbound_echo_unproven')
  if (!chat || !/^[0-9]{5,20}@(c\.us|lid)$/.test(chat) || message.providerMessageIdentityKind !== 'native') return hold()
  const inbound: NormalizedInbound = { message, contact: { wa_id: message.from, profile: { name: '' } } }
  if (chat.endsWith('@lid') && !await hydrateOpenWAInboundSenderPhone(db, { accountId, connectionId: message.connectionId, sessionId: receipt.sessionId, inbound })) return hold()
  const phone = inbound.message.from.replace(/^\+/, '')
  if (!/^[1-9][0-9]{6,14}$/.test(phone) || (chat.endsWith('@c.us') && phone !== chat.slice(0,-5))) return hold()
  const contact = await findOrCreateContact(accountId, ownerUserId, phone, '')
  if (!contact || String(contact.contact.phone).replace(/\D/g,'') !== phone) return hold()
  const parent = await findOrCreateConversation(accountId, ownerUserId, contact.contact.id)
  if (!parent) throw new Error('Canonical echo parent unavailable')
  const kind = ['image','video','audio','document'].includes(message.type) ? message.type as 'image'|'video'|'audio'|'document' : 'text'
  const media = kind === 'text' ? null : message[kind]
  const text = kind === 'text' ? message.text?.body ?? '' : media?.caption ?? media?.filename ?? `[${kind}]`
  if (kind === 'text' && !text.trim()) return hold()
  const { data, error } = await db.rpc('inbox_commit_outbound_echo', {
    p_account: accountId, p_connection: message.connectionId, p_event: receipt.eventId, p_token: receipt.token,
    p_session: receipt.sessionId, p_instance: receipt.instanceId, p_conversation: parent.conversation.id,
    p_native: message.providerMessageId, p_native_proven: true, p_chat: chat, p_peer_phone: phone,
    p_kind: kind, p_text: text, p_mime: media?.mime_type ?? null, p_at: new Date(Number(message.timestamp)*1000).toISOString(), p_payload: canonicalReviewPayload(message),
  })
  if (error || !data || !['review','existing','inserted'].includes(data.state)) throw new Error('Canonical echo persistence unconfirmed')
  if (data.state !== 'review' && media && typeof data.messageId === 'string' && data.conversationId === parent.conversation.id) {
    try { await hydrateOpenWAInboundMessageMedia({ db, storage, accountId, conversationId: data.conversationId, inboundMessageId: data.messageId, message, signedInlineMedia }) }
    catch { console.warn('[inbox] scoped echo media recovery unavailable') }
  }
}
export async function reconcileCanonicalAck(db: SupabaseClient, input: NormalizedWhatsAppStatus, receipt: { eventId: string | null; token: string; sessionId: string; instanceId: string | null; jobId?: string }): Promise<'updated'|'ignored'|'unknown'> {
  const { data, error } = await db.rpc('inbox_apply_canonical_ack', {
    p_account: input.accountId, p_connection: input.connectionId, p_event: receipt.eventId, p_token: receipt.token,
    p_session: receipt.sessionId, p_instance: receipt.instanceId, p_native: input.providerMessageId, p_status: input.status, p_job: receipt.jobId ?? null,
  })
  if (error || !['updated','ignored','unknown'].includes(data)) throw new Error('Canonical ACK outcome unavailable')
  return data
}
