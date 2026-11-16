import type { SupabaseClient } from '@supabase/supabase-js'
import { WhatsAppTransportError } from '../types'
import { isOpenWAOneToOneChatId } from './recipient'

export interface OpenWAInboundContactIdentity {
  phone: string
  /** Existing account-scoped contact established by a prior signed inbound. */
  contactId: string | null
  source: 'sender_phone' | 'historical_native_lid'
}

interface ResolveIdentityInput {
  accountId: string
  connectionId: string
  sender: string
  providerChatId: string | undefined
}

function unavailable(step: string, error: unknown): never {
  throw new WhatsAppTransportError('retryable_provider_failure',
    `OpenWA sender identity lookup unavailable (${step})`, error)
}

function unresolved(): never {
  throw new WhatsAppTransportError('connection_restricted',
    'OpenWA LID has no unique verified phone binding on this WhatsApp account. No CRM contact was created; verify senderPhone from the provider or reconcile the native identity.')
}

/**
 * OpenWA LIDs are opaque WhatsApp chat identities, NOT telephone numbers.
 * A signed webhook may supply a distinct real senderPhone; otherwise reuse
 * ONLY an already-observed native chat mapped to one real contact through a
 * prior signed inbound on the same tenant and same linked WhatsApp phone.
 * Never infer a telephone number from @lid digits, names or a fuzzy suffix.
 */
export async function resolveOpenWAInboundContactIdentity(
  db: SupabaseClient,
  input: ResolveIdentityInput,
): Promise<OpenWAInboundContactIdentity> {
  const chat = input.providerChatId
  if (!isOpenWAOneToOneChatId(chat)) {
    throw new WhatsAppTransportError('connection_restricted',
      'OpenWA one-to-one sender chat identity is missing or inconsistent; no CRM contact was created')
  }
  const sender = input.sender.trim()
  const validPhone = /^\+?[1-9][0-9]{6,14}$/.test(sender)
  const phone = validPhone ? sender.replace(/^\+/, '') : null
  if (chat.endsWith('@c.us')) {
    const expected = chat.slice(0, -'@c.us'.length)
    if (phone !== expected) {
      throw new WhatsAppTransportError('connection_restricted',
        'OpenWA sender phone does not match its verified native chat; no CRM contact was created')
    }
    return { phone, contactId: null, source: 'sender_phone' }
  }
  const opaqueLidDigits = chat.slice(0, -'@lid'.length)
  if (phone && phone !== opaqueLidDigits) {
    // A signed OpenWA event explicitly supplied a phone DISTINCT from the
    // LID. Historical mismatches can still be surfaced during reconciliation.
    return { phone, contactId: null, source: 'sender_phone' }
  }

  const { data: current, error: currentError } = await db.from('whatsapp_connections')
    .select('phone_identity')
    .eq('id', input.connectionId).eq('account_id', input.accountId)
    .eq('provider', 'openwa').is('archived_at', null).maybeSingle()
  if (currentError) unavailable('current-connection', currentError)
  if (!current?.phone_identity) unresolved()

  const { data: related, error: relatedError } = await db.from('whatsapp_connections')
    .select('id').eq('account_id', input.accountId)
    .eq('provider', 'openwa').eq('phone_identity', current.phone_identity).limit(100)
  if (relatedError) unavailable('same-phone-connections', relatedError)
  if (!related?.length || related.length >= 100) unresolved()

  const { data: inbound, error: inboundError } = await db.from('messages')
    .select('conversation_id')
    .eq('provider', 'openwa').eq('sender_type', 'customer')
    .eq('provider_chat_id', chat)
    .in('connection_id', related.map(row => row.id))
    .order('created_at', { ascending: false }).limit(200)
  if (inboundError) unavailable('native-chat-history', inboundError)
  if (!inbound?.length || inbound.length >= 200) unresolved()

  const conversations = [...new Set(inbound.map(row => row.conversation_id))]
  const { data: threads, error: threadsError } = await db.from('conversations')
    .select('id,contact_id').eq('account_id', input.accountId)
    .in('id', conversations).limit(200)
  if (threadsError) unavailable('historical-conversations', threadsError)
  // If some identity history belongs to a different tenant, fail closed,
  // rather than borrowing a phone from the remaining subset.
  if (!threads || threads.length !== conversations.length) unresolved()
  const contactIds = [...new Set(threads.map(row => row.contact_id))]
  const { data: contacts, error: contactsError } = await db.from('contacts')
    .select('id,phone,phone_normalized').eq('account_id', input.accountId)
    .in('id', contactIds).limit(200)
  if (contactsError) unavailable('historical-contacts', contactsError)
  if (!contacts || contacts.length !== contactIds.length) unresolved()

  // Older buggy imports might have stored the numeric part of the LID in
  // contacts.phone. These are explicitly ignored, never treated as evidence.
  const bound = contacts.filter(contact => {
    const candidate = contact.phone_normalized ?? contact.phone?.replace(/\D/g, '')
    return typeof candidate === 'string'
      && /^[1-9][0-9]{6,14}$/.test(candidate)
      && candidate !== opaqueLidDigits
  })
  if (bound.length !== 1) unresolved()
  const resolved = bound[0]
  const resolvedPhone = resolved.phone_normalized ?? resolved.phone.replace(/\D/g, '')
  return { phone: resolvedPhone, contactId: resolved.id, source: 'historical_native_lid' }
}
