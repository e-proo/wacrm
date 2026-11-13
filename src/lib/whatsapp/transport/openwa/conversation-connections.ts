import type { SupabaseClient } from '@supabase/supabase-js'
import { WhatsAppTransportError } from '../types'

export interface OpenWASendConnectionOption {
  id: string
  display_name: string
  status: string
  gateway_host: string
}

export interface ConversationOpenWAConnections {
  current_connection_id: string | null
  options: OpenWASendConnectionOption[]
  /** Account- and phone-verified sessions that cannot send yet.
   * Read-only visibility lets the admin refresh a stale disconnected state
   * without treating the session as an eligible sender. */
  unavailable_options: OpenWASendConnectionOption[]
  identity_unavailable?: boolean
}

/** Only offer active sessions belonging to the same account and the same
 * provider-verified WhatsApp phone as the conversation's latest inbound
 * connection. Never infer phone identity from an @lid JID or contact record.
 * Read-only; does not rebind existing messages, sessions or credentials. */
export async function listConversationOpenWASendConnections(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<ConversationOpenWAConnections> {
  const { data: conversation, error: conversationError } = await db.from('conversations')
    .select('id').eq('id', conversationId).eq('account_id', accountId).maybeSingle()
  if (conversationError || !conversation) {
    throw new WhatsAppTransportError('authentication_or_configuration', 'Conversation is not available in this account')
  }

  const { data: inbound, error: inboundError } = await db.from('messages')
    .select('connection_id, provider').eq('conversation_id', conversationId)
    .eq('sender_type', 'customer').order('created_at', { ascending: false })
    .limit(1).maybeSingle()
  if (inboundError) throw new WhatsAppTransportError('retryable_provider_failure', 'Could not resolve conversation connection')
  if (!inbound?.connection_id || inbound.provider !== 'openwa') return { current_connection_id: null, options: [], unavailable_options: [] }

  const { data: current, error: currentError } = await db.from('whatsapp_connections')
    .select('id, phone_identity').eq('id', inbound.connection_id).eq('account_id', accountId)
    .eq('provider', 'openwa').maybeSingle()
  if (currentError || !current?.phone_identity) {
    return { current_connection_id: inbound.connection_id, options: [], unavailable_options: [], identity_unavailable: true }
  }

  const { data: candidates, error: candidateError } = await db.from('whatsapp_connections')
    .select('id, display_name, status, session_id, phone_identity')
    .eq('account_id', accountId).eq('provider', 'openwa')
    .eq('phone_identity', current.phone_identity)
    .is('archived_at', null)
    .not('session_id', 'is', null)
    .order('updated_at', { ascending: false })
  if (candidateError) throw new WhatsAppTransportError('retryable_provider_failure', 'Could not load OpenWA connection options')
  if (!candidates?.length) return { current_connection_id: inbound.connection_id, options: [], unavailable_options: [] }

  // Only the host is returned to the agent; never reveal keys, encrypted
  // credentials, webhook URLs, session IDs, or phone identities.
  const ids = candidates.map((candidate) => candidate.id)
  const { data: credentials, error: credentialsError } = await db.from('whatsapp_connection_credentials')
    .select('connection_id, base_url').eq('account_id', accountId)
    .eq('provider', 'openwa').in('connection_id', ids)
  if (credentialsError) throw new WhatsAppTransportError('retryable_provider_failure', 'Could not load OpenWA gateway identities')
  const hosts = new Map((credentials ?? []).map((row) => {
    let host = ''
    try { host = new URL(row.base_url).hostname } catch { /* invalid server record */ }
    return [row.connection_id, host]
  }))
  const matching = candidates.filter((candidate) => candidate.phone_identity === current.phone_identity)
  const choices = matching.map((candidate) => ({
    id: candidate.id,
    display_name: candidate.display_name ?? 'WhatsApp Web',
    status: hosts.has(candidate.id) ? candidate.status : 'credentials_missing',
    gateway_host: hosts.get(candidate.id) ?? '',
  }))
  const ready = (choice: OpenWASendConnectionOption) =>
    (choice.status === 'ready' || choice.status === 'connected') && Boolean(choice.gateway_host)
  return {
    current_connection_id: inbound.connection_id,
    options: choices.filter(ready),
    unavailable_options: choices.filter((choice) => !ready(choice)),
  }
}

/** Explicit human-controlled session selection. Account and phone identity
 * are checked again at send/read time; a fabricated connection_id cannot
 * switch tenants or send from an unrelated WhatsApp phone. */
export async function authorizeConversationOpenWASendConnection(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  requestedConnectionId: string,
): Promise<void> {
  const available = await listConversationOpenWASendConnections(db, accountId, conversationId)
  if (!available.current_connection_id || !available.options.some((candidate) => candidate.id === requestedConnectionId)) {
    throw new WhatsAppTransportError('connection_restricted', 'Selected OpenWA connection does not match the conversation account and WhatsApp identity')
  }
}
