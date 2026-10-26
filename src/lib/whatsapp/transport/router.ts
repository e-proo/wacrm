import type { SupabaseClient } from '@supabase/supabase-js'

import { resolveMetaTransport } from './meta-adapter'
import { resolveOpenWATransport } from './openwa/adapter'
import { WhatsAppTransportError, type WhatsAppProvider, type WhatsAppTransport } from './types'

interface ConnectionRow {
  id: string
  account_id: string
  provider: WhatsAppProvider
}

export interface ResolvedWhatsAppTransport {
  connectionId: string
  transport: WhatsAppTransport
}

/** Resolve an explicit WACRM connection. Business callers never select an OpenWA engine. */
export async function resolveWhatsAppTransport(
  db: SupabaseClient,
  accountId: string,
  connectionId?: string | null,
): Promise<ResolvedWhatsAppTransport> {
  if (!connectionId) return resolveMetaTransport(db, accountId)

  const { data, error } = await db
    .from('whatsapp_connections')
    .select('id, account_id, provider')
    .eq('id', connectionId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error || !data) {
    throw new WhatsAppTransportError('authentication_or_configuration', 'WhatsApp connection is not configured for this account', error)
  }
  const connection = data as ConnectionRow
  if (connection.provider === 'openwa') return resolveOpenWATransport(db, accountId, connection.id)
  if (connection.provider === 'meta_cloud') {
    const resolved = await resolveMetaTransport(db, accountId)
    if (resolved.connectionId !== connection.id) {
      throw new WhatsAppTransportError('authentication_or_configuration', 'Resolved Meta connection does not match the requested WACRM connection')
    }
    return resolved
  }
  throw new WhatsAppTransportError('unsupported_capability', 'Unsupported WhatsApp provider')
}

/**
 * Keep replies and ongoing threads on the provider-neutral connection that
 * received the latest customer message. Outbound-first conversations retain
 * Meta as the official/default provider.
 */
export async function resolveConversationTransport(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  requestedConnectionId?: string | null,
): Promise<ResolvedWhatsAppTransport> {
  const { data: conversation, error: conversationError } = await db
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (conversationError || !conversation) {
    throw new WhatsAppTransportError('invalid_request', 'Conversation not found for this account', conversationError)
  }

  if (requestedConnectionId) return resolveWhatsAppTransport(db, accountId, requestedConnectionId)

  const { data: inbound, error: inboundError } = await db
    .from('messages')
    .select('connection_id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .not('connection_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (inboundError) {
    throw new WhatsAppTransportError('retryable_provider_failure', 'Could not resolve the conversation WhatsApp connection', inboundError)
  }

  return resolveWhatsAppTransport(db, accountId, inbound?.connection_id ?? null)
}
