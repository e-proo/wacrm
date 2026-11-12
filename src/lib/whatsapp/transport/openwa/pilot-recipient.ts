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
  const { data: contacts, error: contactsError } = await db.from('contacts')
    .select('id').eq('account_id', accountId)
    .in('phone', [phone, `+${phone}`]).limit(3)
  if (contactsError) failedLookup('resolve contact identity', contactsError)
  if ((contacts?.length ?? 0) > 1) {
    throw new WhatsAppTransportError('connection_restricted', 'Multiple contacts match this recipient; choose a verified OpenWA chat identity explicitly')
  }
  if (!contacts?.length) return { recipient: canonical, source: 'phone_without_inbound' }

  const { data: threads, error: threadsError } = await db.from('conversations')
    .select('id').eq('account_id', accountId).eq('contact_id', contacts[0].id)
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
  if (!inbound?.length) return { recipient: canonical, source: 'phone_without_inbound' }

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
