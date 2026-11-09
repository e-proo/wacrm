import type { SupabaseClient } from '@supabase/supabase-js'

import { resolveOpenWACredentials } from './credentials'
import { verifyOpenWAWebhookSignature } from './webhook-signature'

interface OpenWAWebhookConnectionRow {
  id: string
  account_id: string
  provider: 'openwa'
  session_id: string | null
  instance_id: string | null
  status: string
}

export interface OpenWAWebhookEnvelope {
  eventId: string
  timestamp: string
  sessionId: string
  instanceId?: string
  event: string
  data?: unknown
}

export interface ReservedOpenWAWebhook {
  accountId: string
  connectionId: string
  envelope: OpenWAWebhookEnvelope
  duplicate: boolean
}

/**
 * Stable diagnostic categories for rejected intake requests.
 * Intentionally do not return arbitrary exception text to logs: some upstream
 * errors can contain request details or credentials.
 */
export function classifyOpenWAWebhookRejection(error: unknown): string {
  if (!(error instanceof Error)) return 'unexpected_error'
  switch (error.message) {
    case 'Invalid OpenWA webhook JSON': return 'invalid_json'
    case 'Invalid OpenWA webhook payload': return 'invalid_payload'
    case 'OpenWA webhook requires idempotencyKey, timestamp, sessionId, and event': return 'missing_envelope_fields'
    case 'Unknown OpenWA session': return 'unknown_session'
    case 'OpenWA instance binding failed': return 'instance_binding_failed'
    case 'OpenWA session is not active': return 'inactive_session'
    case 'OpenWA webhook secret is not configured': return 'missing_webhook_secret'
    case 'Invalid OpenWA webhook signature': return 'invalid_signature'
    case 'OpenWA webhook receipt could not be reserved': return 'receipt_reservation_failed'
    case 'OpenWA connection is not configured for this account': return 'missing_connection'
    case 'OpenWA credentials are not configured for this connection': return 'missing_credentials'
    case 'OpenWA credential scope mismatch': return 'credential_scope_mismatch'
    case 'OpenWA credentials could not be decrypted': return 'credential_decryption_failed'
    case 'Server database credentials are not configured': return 'server_db_configuration_missing'
    default: return 'unexpected_error'
  }
}

export function parseOpenWAWebhookEnvelope(rawBody: string): OpenWAWebhookEnvelope {
  let value: unknown
  try {
    value = JSON.parse(rawBody)
  } catch {
    throw new Error('Invalid OpenWA webhook JSON')
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid OpenWA webhook payload')
  }

  const body = value as Record<string, unknown>
  // OpenWA idempotencyKey is stable across delivery retries, unlike deliveryId.
  const eventId = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : ''
  const timestamp = typeof body.timestamp === 'string' ? body.timestamp.trim() : ''
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  const instanceId = typeof body.instanceId === 'string' ? body.instanceId.trim() : undefined
  const event = typeof body.event === 'string' ? body.event.trim() : ''

  if (!eventId || !timestamp || !sessionId || !event) {
    throw new Error('OpenWA webhook requires idempotencyKey, timestamp, sessionId, and event')
  }

  return { eventId, timestamp, sessionId, instanceId: instanceId || undefined, event, data: body.data }
}

export async function verifyAndReserveOpenWAWebhook(
  db: SupabaseClient,
  input: {
    rawBody: string
    signature: string | null
    nowMs?: number
  },
): Promise<ReservedOpenWAWebhook> {
  const envelope = parseOpenWAWebhookEnvelope(input.rawBody)

  // Resolve by OpenWA session identity, then pin every subsequent lookup to
  // the resulting account + connection. Never accept an account identifier
  // from the webhook payload as an authorization boundary.
  let query = db
    .from('whatsapp_connections')
    .select('id, account_id, provider, session_id, instance_id, status')
    .eq('provider', 'openwa')
    .eq('session_id', envelope.sessionId)

  // Older WACRM session records predate instance binding. A signed event
  // from that session can establish the first instance identity, but an
  // unsigned or wrong-instance event must never be able to claim it.
  // A duplicated session ID across tenants remains ambiguous and fails
  // closed through maybeSingle rather than guessing an account.
  const { data: connection, error: connectionError } = await query.maybeSingle()
  if (connectionError || !connection) throw new Error('Unknown OpenWA session')

  const scoped = connection as OpenWAWebhookConnectionRow
  if (scoped.instance_id && scoped.instance_id !== envelope.instanceId) {
    throw new Error('Unknown OpenWA session')
  }
  const lifecycleEvent = ['session.status', 'session.authenticated', 'session.disconnected', 'session.restriction'].includes(envelope.event)
  if (!['connected', 'ready'].includes(scoped.status) && !lifecycleEvent) {
    throw new Error('OpenWA session is not active')
  }

  const credentials = await resolveOpenWACredentials(db, scoped.account_id, scoped.id)
  if (!credentials.webhookSecret) throw new Error('OpenWA webhook secret is not configured')

  if (!verifyOpenWAWebhookSignature({
    rawBody: input.rawBody,
    signature: input.signature,
    timestamp: envelope.timestamp,
    secret: credentials.webhookSecret,
    nowMs: input.nowMs,
  })) {
    throw new Error('Invalid OpenWA webhook signature')
  }

  if (envelope.instanceId && !scoped.instance_id) {
    // Bind legacy rows only after a valid HMAC. Account/connection/provider
    // scope and NULL CAS protect against cross-tenant or concurrent rebinds.
    const { data: pinned, error: pinError } = await db
      .from('whatsapp_connections')
      .update({ instance_id: envelope.instanceId })
      .eq('id', scoped.id)
      .eq('account_id', scoped.account_id)
      .eq('provider', 'openwa')
      .is('instance_id', null)
      .select('id')
      .maybeSingle()
    if (pinError) throw new Error('OpenWA instance binding failed')
    if (!pinned) {
      // A concurrent valid event may already have bound this same instance.
      const { data: current, error: currentError } = await db
        .from('whatsapp_connections')
        .select('instance_id')
        .eq('id', scoped.id)
        .eq('account_id', scoped.account_id)
        .eq('provider', 'openwa')
        .maybeSingle()
      if (currentError || current?.instance_id !== envelope.instanceId) {
        throw new Error('Unknown OpenWA session')
      }
    }
  }

  const { error: insertError } = await db.from('whatsapp_webhook_event_receipts').insert({
    account_id: scoped.account_id,
    connection_id: scoped.id,
    provider: 'openwa',
    provider_event_id: envelope.eventId,
  })

  if (!insertError) {
    return { accountId: scoped.account_id, connectionId: scoped.id, envelope, duplicate: false }
  }

  const code = (insertError as { code?: string }).code
  if (code === '23505') {
    return { accountId: scoped.account_id, connectionId: scoped.id, envelope, duplicate: true }
  }

  // PostgreSQL/PostgREST error codes are safe to log; their free-form messages and hints are not.
  const dbCode = typeof code === 'string' && /^[a-zA-Z0-9_]{3,12}$/.test(code) ? code : 'unknown'
  console.error('[openwa-webhook] receipt reservation rejected', { dbCode })
  throw new Error('OpenWA webhook receipt could not be reserved')
}

export async function markOpenWAWebhookProcessed(
  db: SupabaseClient,
  connectionId: string,
  providerEventId: string,
  processingError?: string,
): Promise<void> {
  const { error } = await db
    .from('whatsapp_webhook_event_receipts')
    .update({
      processed_at: new Date().toISOString(),
      processing_error: processingError ? processingError.slice(0, 1000) : null,
    })
    .eq('connection_id', connectionId)
    .eq('provider', 'openwa')
    .eq('provider_event_id', providerEventId)

  if (error) throw new Error('OpenWA webhook receipt could not be finalized')
}