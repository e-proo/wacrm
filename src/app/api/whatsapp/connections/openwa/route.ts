import { randomUUID } from 'crypto'
import { NextResponse } from 'next/server'

import { encrypt } from '@/lib/whatsapp/encryption'
import { validateOpenWABaseUrl } from '@/lib/whatsapp/transport/openwa/client'
import { requireOpenWASessionAdmin } from '@/lib/whatsapp/transport/openwa/session-auth'
import { resolveOpenWAClient } from '@/lib/whatsapp/transport/openwa/credentials'
import { normalizeOpenWAConnectionState } from '@/lib/whatsapp/transport/openwa/session-lifecycle'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

const noStore = { 'Cache-Control': 'no-store, private, max-age=0' }

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'OpenWA session request failed'
  const code = error instanceof WhatsAppTransportError ? error.code : 'retryable_provider_failure'
  const status = code === 'authentication_or_configuration' ? 403 : code === 'invalid_request' ? 400 : code === 'connection_restricted' ? 409 : 502
  return NextResponse.json({ error: message, code }, { status, headers: noStore })
}

export async function GET() {
  try {
    const { accountId, userDb } = await requireOpenWASessionAdmin()
    const { data, error } = await userDb
      .from('whatsapp_connections')
      .select('id, display_name, phone_identity, status, session_id, instance_id, engine, connected_at, disconnected_at, restricted_at, created_at, updated_at')
      .eq('account_id', accountId)
      .eq('provider', 'openwa')
      .order('created_at', { ascending: false })
    if (error) throw new WhatsAppTransportError('retryable_provider_failure', 'Failed to load OpenWA connections', error)
    return NextResponse.json({ connections: data ?? [] }, { headers: noStore })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, adminDb } = await requireOpenWASessionAdmin()
    const body = await request.json() as Record<string, unknown>
    const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : ''
    const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
    const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : 'WhatsApp Web'
    const engine = body.engine === 'whatsapp-web.js' || body.engine === 'baileys' ? body.engine : undefined
    if (!baseUrl || !apiKey) throw new WhatsAppTransportError('invalid_request', 'OpenWA base URL and API key are required')

    const allowedHosts = (process.env.OPENWA_ALLOWED_HOSTS ?? '').split(',').map((value) => value.trim()).filter(Boolean)
    const validatedUrl = validateOpenWABaseUrl(baseUrl, allowedHosts)
    const sessionId = randomUUID()
    const connectionId = randomUUID()

    const { data: duplicate } = await adminDb
      .from('whatsapp_connections')
      .select('id')
      .eq('account_id', accountId)
      .eq('provider', 'openwa')
      .eq('session_id', sessionId)
      .maybeSingle()
    if (duplicate) throw new WhatsAppTransportError('connection_restricted', 'OpenWA session already exists')

    const { error: connectionError } = await adminDb.from('whatsapp_connections').insert({
      id: connectionId,
      account_id: accountId,
      provider: 'openwa',
      display_name: displayName || 'WhatsApp Web',
      status: 'creating',
      session_id: sessionId,
      engine: engine ?? null,
    })
    if (connectionError) throw new WhatsAppTransportError('retryable_provider_failure', 'Failed to create OpenWA connection', connectionError)

    try {
      const { error: credentialError } = await adminDb.from('whatsapp_connection_credentials').insert({
        connection_id: connectionId,
        account_id: accountId,
        provider: 'openwa',
        base_url: validatedUrl.origin + (validatedUrl.pathname === '/' ? '' : validatedUrl.pathname),
        api_key_encrypted: encrypt(apiKey),
      })
      if (credentialError) throw credentialError

      const { client } = await resolveOpenWAClient(adminDb, accountId, connectionId, { allowedHosts })
      const created = await client.createSession({ sessionId, engine, correlationId: connectionId, idempotencyKey: connectionId })
      const status = normalizeOpenWAConnectionState(created.status)
      const { error: updateError } = await adminDb
        .from('whatsapp_connections')
        .update({ status, phone_identity: created.phoneIdentity ?? null })
        .eq('id', connectionId)
        .eq('account_id', accountId)
        .eq('provider', 'openwa')
      if (updateError) throw updateError

      return NextResponse.json({ connection: { id: connectionId, session_id: sessionId, status, engine: engine ?? null } }, { status: 201, headers: noStore })
    } catch (error) {
      await adminDb.from('whatsapp_connections').delete().eq('id', connectionId).eq('account_id', accountId).eq('provider', 'openwa')
      throw error
    }
  } catch (error) {
    return errorResponse(error)
  }
}
