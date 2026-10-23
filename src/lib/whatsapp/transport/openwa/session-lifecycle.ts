import type { SupabaseClient } from '@supabase/supabase-js'

import { WhatsAppTransportError } from '../types'
import type { OpenWASessionStatus } from './client'
import { resolveOpenWAClient } from './credentials'

export const OPENWA_CONNECTION_STATES = [
  'creating',
  'waiting_qr',
  'authenticating',
  'connected',
  'ready',
  'disconnected',
  'reconnecting',
  'restricted',
  'logged_out',
  'failed',
] as const

export type OpenWAConnectionState = (typeof OPENWA_CONNECTION_STATES)[number]

interface OpenWAConnectionRow {
  id: string
  account_id: string
  session_id: string | null
  status: OpenWAConnectionState
  phone_identity: string | null
}

const STATE_ALIASES: Record<string, OpenWAConnectionState> = {
  qr: 'waiting_qr',
  qr_ready: 'waiting_qr',
  waiting_for_qr: 'waiting_qr',
  authenticated: 'connected',
  online: 'ready',
  open: 'ready',
  reconnecting: 'reconnecting',
  banned: 'restricted',
  blocked: 'restricted',
  logout: 'logged_out',
  closed: 'disconnected',
  error: 'failed',
}

const ALLOWED_TRANSITIONS: Record<OpenWAConnectionState, ReadonlySet<OpenWAConnectionState>> = {
  creating: new Set(['creating', 'waiting_qr', 'authenticating', 'connected', 'ready', 'restricted', 'failed', 'logged_out']),
  waiting_qr: new Set(['waiting_qr', 'authenticating', 'connected', 'ready', 'restricted', 'failed', 'logged_out']),
  authenticating: new Set(['authenticating', 'connected', 'ready', 'disconnected', 'reconnecting', 'restricted', 'failed', 'logged_out']),
  connected: new Set(['connected', 'ready', 'disconnected', 'reconnecting', 'restricted', 'failed', 'logged_out']),
  ready: new Set(['ready', 'disconnected', 'reconnecting', 'restricted', 'failed', 'logged_out']),
  disconnected: new Set(['disconnected', 'reconnecting', 'waiting_qr', 'authenticating', 'connected', 'ready', 'restricted', 'failed', 'logged_out']),
  reconnecting: new Set(['reconnecting', 'connected', 'ready', 'disconnected', 'restricted', 'failed', 'logged_out']),
  restricted: new Set(['restricted', 'logged_out']),
  logged_out: new Set(['logged_out']),
  failed: new Set(['failed', 'reconnecting', 'waiting_qr', 'logged_out']),
}

export function normalizeOpenWAConnectionState(value: unknown): OpenWAConnectionState {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if ((OPENWA_CONNECTION_STATES as readonly string[]).includes(normalized)) {
    return normalized as OpenWAConnectionState
  }
  return STATE_ALIASES[normalized] ?? 'failed'
}

export function canApplyOpenWAStateTransition(current: OpenWAConnectionState, next: OpenWAConnectionState): boolean {
  return ALLOWED_TRANSITIONS[current].has(next)
}

async function loadOpenWAConnection(db: SupabaseClient, accountId: string, connectionId: string): Promise<OpenWAConnectionRow> {
  const { data, error } = await db
    .from('whatsapp_connections')
    .select('id, account_id, session_id, status, phone_identity')
    .eq('id', connectionId)
    .eq('account_id', accountId)
    .eq('provider', 'openwa')
    .maybeSingle()

  if (error || !data) {
    throw new WhatsAppTransportError('authentication_or_configuration', 'OpenWA connection is not configured for this account', error)
  }
  return data as OpenWAConnectionRow
}

async function persistStatus(
  db: SupabaseClient,
  connection: OpenWAConnectionRow,
  providerStatus: OpenWASessionStatus,
): Promise<OpenWAConnectionState> {
  const next = normalizeOpenWAConnectionState(providerStatus.status)
  if (!canApplyOpenWAStateTransition(connection.status, next)) return connection.status

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { status: next }
  if (providerStatus.phoneIdentity) patch.phone_identity = providerStatus.phoneIdentity
  if (next === 'connected' || next === 'ready') {
    patch.connected_at = now
    patch.disconnected_at = null
  }
  if (next === 'disconnected' || next === 'logged_out' || next === 'failed') patch.disconnected_at = now
  if (next === 'restricted') patch.restricted_at = now

  const { error } = await db
    .from('whatsapp_connections')
    .update(patch)
    .eq('id', connection.id)
    .eq('account_id', connection.account_id)
    .eq('provider', 'openwa')
    .eq('status', connection.status)

  if (error) throw new WhatsAppTransportError('retryable_provider_failure', 'Failed to persist OpenWA connection state', error)
  return next
}

export async function refreshOpenWAConnectionStatus(db: SupabaseClient, accountId: string, connectionId: string) {
  const connection = await loadOpenWAConnection(db, accountId, connectionId)
  if (!connection.session_id) throw new WhatsAppTransportError('invalid_request', 'OpenWA connection has no session id')
  const { client } = await resolveOpenWAClient(db, accountId, connectionId)
  const providerStatus = await client.getSessionStatus(connection.session_id, connectionId)
  const status = await persistStatus(db, connection, providerStatus)
  return { status, phoneIdentity: providerStatus.phoneIdentity ?? connection.phone_identity }
}

export async function reconnectOpenWAConnection(db: SupabaseClient, accountId: string, connectionId: string) {
  const connection = await loadOpenWAConnection(db, accountId, connectionId)
  if (!connection.session_id) throw new WhatsAppTransportError('invalid_request', 'OpenWA connection has no session id')
  if (!canApplyOpenWAStateTransition(connection.status, 'reconnecting')) {
    throw new WhatsAppTransportError('connection_restricted', `OpenWA connection cannot reconnect from ${connection.status}`)
  }
  const { client } = await resolveOpenWAClient(db, accountId, connectionId)
  const providerStatus = await client.reconnectSession(connection.session_id, connectionId)
  return { status: await persistStatus(db, connection, providerStatus) }
}

export async function logoutOpenWAConnection(db: SupabaseClient, accountId: string, connectionId: string) {
  const connection = await loadOpenWAConnection(db, accountId, connectionId)
  if (!connection.session_id) throw new WhatsAppTransportError('invalid_request', 'OpenWA connection has no session id')
  const { client } = await resolveOpenWAClient(db, accountId, connectionId)
  await client.logoutSession(connection.session_id, connectionId)
  const providerStatus: OpenWASessionStatus = { sessionId: connection.session_id, status: 'logged_out' }
  return { status: await persistStatus(db, connection, providerStatus) }
}
