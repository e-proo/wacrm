import { NextResponse } from 'next/server'

import { requireOpenWASessionAdmin } from '@/lib/whatsapp/transport/openwa/session-auth'
import { logoutOpenWAConnection, reconnectOpenWAConnection, refreshOpenWAConnectionStatus } from '@/lib/whatsapp/transport/openwa/session-lifecycle'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

const noStore = { 'Cache-Control': 'no-store, private, max-age=0' }

type Context = { params: Promise<{ connectionId: string }> }

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'OpenWA session request failed'
  const code = error instanceof WhatsAppTransportError ? error.code : 'retryable_provider_failure'
  const status = code === 'authentication_or_configuration' ? 403 : code === 'invalid_request' ? 404 : code === 'connection_restricted' ? 409 : 502
  return NextResponse.json({ error: message, code }, { status, headers: noStore })
}

export async function GET(_request: Request, context: Context) {
  try {
    const { connectionId } = await context.params
    const { accountId, adminDb } = await requireOpenWASessionAdmin()
    const result = await refreshOpenWAConnectionStatus(adminDb, accountId, connectionId)
    return NextResponse.json(result, { headers: noStore })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const { connectionId } = await context.params
    const { accountId, adminDb } = await requireOpenWASessionAdmin()
    const body = await request.json() as Record<string, unknown>
    if (body.action !== 'reconnect') throw new WhatsAppTransportError('invalid_request', 'Unsupported OpenWA session action')
    const result = await reconnectOpenWAConnection(adminDb, accountId, connectionId)
    return NextResponse.json(result, { headers: noStore })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const { connectionId } = await context.params
    const { accountId, adminDb } = await requireOpenWASessionAdmin()
    const result = await logoutOpenWAConnection(adminDb, accountId, connectionId)
    return NextResponse.json(result, { headers: noStore })
  } catch (error) {
    return errorResponse(error)
  }
}
