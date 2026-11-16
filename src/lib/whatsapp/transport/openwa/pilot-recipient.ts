import type { SupabaseClient } from '@supabase/supabase-js'
import { WhatsAppTransportError } from '../types'
import { canonicalOpenWAPilotRecipient } from '../guardrails'
import { isOpenWAOneToOneChatId } from './recipient'

export interface OpenWAPilotRecipientResolution {
  recipient: string
  source: 'verified_inbound_chat' | 'direct_recipient' | 'phone_without_inbound'
}

function failedLookup(action: string, error: unknown): never {
  throw new WhatsAppTransportError('retryable_provider_failure', `Could not ${action} for TEST pilot approval`, error)
}

/**
 * A newly registered same-phone OpenWA session may receive a signed @lid
 * before the old CRM contact/conversation linkage is repaired. Cross-check
 * a native chat from the selected session against a historical chat on the
 * exact contact and same linked WhatsApp phone. This is an approval-time
 * identity lookup, NOT a bypass of the explicit Pilot allowlist.
 */
async function findHistoricalNativeChatOnSelectedSession(
  db: SupabaseClient,
  accountId: string,
  connectionId: string,
  conversationIds: string[],
): Promise<string | null> {
  const { data: selected, error: selectedError } = await db.from('whatsapp_connections')
    .select('phone_identity').eq('account_id', accountId)
    .eq('id', connectionId).eq('provider', 'openwa')
    .is('archived_at', null).maybeSingle()
  if (selectedError) failedLookup('read selected session identity', selectedError)
  if (!selected?.phone_identity) return null

  const { data: related, error: relatedError } = await db.from('whatsapp_connections')
    .select('id').eq('account_id', accountId).eq('provider', 'openwa')
    .eq('phone_identity', selected.phone_identity).limit(100)
  if (relatedError) failedLookup('read same-phone sessions', relatedError)
  if (!related?.length || related.length >= 100) return null

  const { data: historic, error: historicError } = await db.from('messages')
    .select('provider_chat_id')
    .in('conversation_id', conversationIds)
    .in('connection_id', related.map(row => row.id))
    .eq('provider', 'openwa').eq('sender_type', 'customer')
    .order('created_at', { ascending: false }).limit(100)
  if (historicError) failedLookup('read verified contact chat history', historicError)
  if (!historic?.length || historic.length >= 100) return null
  const chats = [...new Set(historic.map(row => row.provider_chat_id).filter(isOpenWAOneToOneChatId))]
  if (!chats.length) return null

  const { data: selectedInbound, error: selectedInboundError } = await db.from('messages')
    .select('conversation_id,provider_chat_id').eq('connection_id', connectionId)
    .eq('provider', 'openwa').eq('sender_type', 'customer')
    .in('provider_chat_id', chats).order('created_at', { ascending: false }).limit(100)
  if (selectedInboundError) failedLookup('verify chat on new session', selectedInboundError)
  if (!selectedInbound?.length || selectedInbound.length >= 100) return null
  // Verify the new inbound conversations also belong to the selected tenant.
  // They may currently point at an incorrect LID-digit contact (the bug being
  // repaired); the exact native ID and same logged-in phone are the evidence.
  const received = [...new Set(selectedInbound.map(row => row.provider_chat_id).filter(isOpenWAOneToOneChatId))]
  if (received.length !== 1) {
    throw new WhatsAppTransportError('connection_restricted',
      'Multiple native OpenWA chats matched this phone across sessions; review the identity manually')
  }
  const convIds = [...new Set(selectedInbound.map(row => row.conversation_id))]
  const { data: scoped, error: scopedError } = await db.from('conversations')
    .select('id').eq('account_id', accountId).in('id', convIds).limit(100)
  if (scopedError) failedLookup('validate current chat account', scopedError)
  if (!scoped || scoped.length !== convIds.length) {
    throw new WhatsAppTransportError('connection_restricted', 'Native OpenWA chat is not scoped to this account')
  }
  return received[0]
}

/**
 * Grant the *same provider-native destination* that WACRM would use for a
 * manual reply to an existing conversation on the chosen OpenWA connection.
 *
 * For a phone input we first find the unique account-scoped contact, then
 * inspect signed/normalized inbound chat IDs on precisely this connection.
 * This does NOT convert @lid digits to an E.164 number or guess identities
 * on unrelated connections. Ambiguities fail closed.
 *
 * No provider dispatch, contact mutation, or plaintext recipient persistence.
 */
export async function resolveOpenWAPilotRecipientForGrant(
  db: SupabaseClient,
  accountId: string,
  connectionId: string,
  input: string,
): Promise<OpenWAPilotRecipientResolution> {
  const canonical = canonicalOpenWAPilotRecipient(input)
  if (!canonical) throw new WhatsAppTransportError('invalid_request', 'Invalid TEST pilot recipient identity')
  // A provided native identity is already precise; never rewrite @lid or @c.us.
  if (input.includes('@lid')) return { recipient: canonical, source: 'direct_recipient' }

  const phone = canonical.slice(0, -'@c.us'.length)
  // A CRM contact can store a formatted display phone while keeping its
  // account-scoped E.164 identity in phone_normalized. Inspect BOTH forms
  // before picking a native @lid; duplicates across forms must fail closed.
  const [
    { data: normalizedContacts, error: normalizedError },
    { data: legacyContacts, error: legacyError },
  ] = await Promise.all([
    db.from('contacts').select('id').eq('account_id', accountId)
      .eq('phone_normalized', phone).limit(3),
    db.from('contacts').select('id').eq('account_id', accountId)
      .in('phone', [phone, `+${phone}`]).limit(3),
  ])
  if (normalizedError || legacyError) {
    failedLookup('resolve contact identity', normalizedError ?? legacyError)
  }
  const contactIds = [...new Set([
    ...(normalizedContacts ?? []), ...(legacyContacts ?? []),
  ].map(contact => contact.id))]
  if (contactIds.length > 1) {
    throw new WhatsAppTransportError('connection_restricted', 'Multiple contacts match this recipient; choose a verified OpenWA chat identity explicitly')
  }
  if (!contactIds.length) return { recipient: canonical, source: 'phone_without_inbound' }

  const { data: threads, error: threadsError } = await db.from('conversations')
    .select('id').eq('account_id', accountId).eq('contact_id', contactIds[0])
    .order('created_at', { ascending: false }).limit(25)
  if (threadsError) failedLookup('resolve recipient conversation', threadsError)
  if (!threads?.length) return { recipient: canonical, source: 'phone_without_inbound' }

  const { data: inbound, error: inboundError } = await db.from('messages')
    .select('conversation_id, provider_chat_id')
    .in('conversation_id', threads.map((thread) => thread.id))
    .eq('connection_id', connectionId).eq('provider', 'openwa')
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false }).limit(25)
  if (inboundError) failedLookup('resolve provider-native chat identity', inboundError)
  if (!inbound?.length) {
    const historical = await findHistoricalNativeChatOnSelectedSession(
      db, accountId, connectionId, threads.map(thread => thread.id),
    )
    return historical
      ? { recipient: historical, source: 'verified_inbound_chat' }
      : { recipient: canonical, source: 'phone_without_inbound' }
  }

  // If the latest inbound row has an unsupported/missing chat ID, the send
  // core would also refuse to reply. Do not approve a guessed phone instead.
  if (!isOpenWAOneToOneChatId(inbound[0].provider_chat_id)) {
    throw new WhatsAppTransportError('connection_restricted', 'The latest inbound OpenWA chat identity cannot be verified; receive a new message before approving')
  }
  // Never choose between different native chats for the same phone. Review
  // the conversation/session mapping instead of approving the wrong one.
  const chatIds = new Set(inbound.map((item) => item.provider_chat_id).filter(isOpenWAOneToOneChatId))
  if (chatIds.size !== 1 || inbound.some((item) => !isOpenWAOneToOneChatId(item.provider_chat_id))) {
    throw new WhatsAppTransportError('connection_restricted', 'Multiple OpenWA chat identities match this contact on this connection; choose the exact native chat')
  }

  return { recipient: inbound[0].provider_chat_id, source: 'verified_inbound_chat' }
}
