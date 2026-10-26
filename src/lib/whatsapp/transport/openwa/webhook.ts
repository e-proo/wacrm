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
  const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : ''
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  const instanceId = typeof body.instanceId === 'string' ? body.instanceId.trim() : undefined
  const event = typeof body.event === 'string' ? body.event.trim() : ''

  if (!eventId || !sessionId || !event) {
    throw new Error('OpenWA webhook requires eventId, sessionId, and event')
  }

  return { eventId, sessionId, instanceId: instanceId || undefined, event, data: body.data }
}

export async function verifyAndReserveOpenWAWebhook(
  db: SupabaseClient,
  input: {
    rawBody: string
    signature: string | null
    timestamp: string | null
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

  if (envelope.instanceId) query = query.eq('instance_id', envelope.instanceId)

  const { data: connection, error: connectionError } = await query.maybeSingle()
  if (connectionError || !connection) throw new Error('Unknown OpenWA session')

  const scoped = connection as OpenWAWebhookConnectionRow
  if (!['connected', 'ready'].includes(scoped.status)) {
    throw new Error('OpenWA session is not active')
  }

  const credentials = await resolveOpenWACredentials(db, scoped.account_id, scoped.id)
  if (!credentials.webhookSecret) throw new Error('OpenWA webhook secret is not configured')

  if (!verifyOpenWAWebhookSignature({
    rawBody: input.rawBody,
    signature: input.signature,
    timestamp: input.timestamp,
    secret: credentials.webhookSecret,
    nowMs: input.nowMs,
  })) {
    throw new Error('Invalid OpenWA webhook signature')
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