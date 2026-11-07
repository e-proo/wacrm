import type { SupabaseClient } from '@supabase/supabase-js'

import { WhatsAppTransportError } from '../types'

/** Strictly the two 1:1 JID dialects supported by the WACRM OpenWA adapter. */
export function isOpenWAOneToOneChatId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{5,20}@(c\.us|lid)$/.test(value)
}

/**
 * Resolve a conversation's provider-native destination from its last received
 * message on this exact connection. A LID is NOT an E.164 number.
 *
 * Legacy OpenWA inbound rows without a verified destination fail closed, so
 * their LID digits can never accidentally become a different @c.us chat.
 * An outbound-only conversation (no OpenWA inbound on this connection) retains
 * the existing explicit phone-number path for legitimate cold outreach.
 */
export async function resolveOpenWAConversationRecipient(
  db: SupabaseClient,
  input: {
    accountId: string
    conversationId: string
    connectionId: string
    fallbackPhone: string
  },
): Promise<string> {
  const { data: conversation, error: conversationError } = await db.from('conversations')
    .select('id')
    .eq('id', input.conversationId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (conversationError || !conversation) {
    throw new WhatsAppTransportError('authentication_or_configuration', 'OpenWA conversation is not in the current account', conversationError)
  }

  const { data: inbound, error: inboundError } = await db.from('messages')
    .select('provider_chat_id')
    .eq('conversation_id', input.conversationId)
    .eq('provider', 'openwa')
    .eq('connection_id', input.connectionId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (inboundError) throw new WhatsAppTransportError('retryable_provider_failure', 'Cannot resolve OpenWA inbound chat identity', inboundError)

  if (inbound) {
    if (!isOpenWAOneToOneChatId(inbound.provider_chat_id)) {
      throw new WhatsAppTransportError(
        'connection_restricted',
        'OpenWA inbound chat identity is missing or unsupported; request a new message before replying',
      )
    }
    return inbound.provider_chat_id
  }

  if (!/^[1-9][0-9]{6,14}$/.test(input.fallbackPhone)) {
    throw new WhatsAppTransportError('invalid_request', 'OpenWA outbound-only recipient must be a valid phone number')
  }
  return input.fallbackPhone
}
