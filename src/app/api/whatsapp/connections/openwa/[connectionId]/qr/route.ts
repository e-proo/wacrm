import { NextResponse } from 'next/server'

import { requireOpenWASessionAdmin } from '@/lib/whatsapp/transport/openwa/session-auth'
import { resolveOpenWAClient } from '@/lib/whatsapp/transport/openwa/credentials'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

const noStore = {
  'Cache-Control': 'no-store, private, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
}
const MAX_QR_TTL_MS = 60_000

type Context = { params: Promise<{ connectionId: string }> }

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'OpenWA QR request failed'
  const code = error instanceof WhatsAppTransportError ? error.code : 'retryable_provider_failure'
  const status = code === 'authentication_or_configuration' ? 403 : code === 'invalid_request' ? 404 : code === 'connection_restricted' ? 409 : 502
  return NextResponse.json({ error: message, code }, { status, headers: noStore })
}

export async function GET(_request: Request, context: Context) {
  try {
    const { connectionId } = await context.params
    const { accountId, adminDb } = await requireOpenWASessionAdmin()
    const { data: connection, error } = await adminDb
      .from('whatsapp_connections')
      .select('session_id, status')
      .eq('id', connectionId)
      .eq('account_id', accountId)
      .eq('provider', 'openwa')
      .maybeSingle()
    if (error || !connection?.session_id) throw new WhatsAppTransportError('invalid_request', 'OpenWA session was not found', error)
    if (!['creating', 'waiting_qr', 'authenticating', 'disconnected'].includes(connection.status)) {
      throw new WhatsAppTransportError('connection_restricted', `QR is not available while connection is ${connection.status}`)
    }

    const { client } = await resolveOpenWAClient(adminDb, accountId, connectionId)
    const qr = await client.getSessionQr(connection.session_id, connectionId)
    const providerExpiry = qr.expiresAt ? Date.parse(qr.expiresAt) : Number.NaN
    const expiresAtMs = Number.isFinite(providerExpiry)
      ? Math.min(providerExpiry, Date.now() + MAX_QR_TTL_MS)
      : Date.now() + MAX_QR_TTL_MS
    if (expiresAtMs <= Date.now()) throw new WhatsAppTransportError('invalid_request', 'OpenWA QR code has expired')

    return NextResponse.json({ qr: qr.qr, expires_at: new Date(expiresAtMs).toISOString() }, { headers: noStore })
  } catch (error) {
    return errorResponse(error)
  }
}
