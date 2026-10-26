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
    const { data: guardrail } = await adminDb.from('whatsapp_connection_guardrails').select('manual_paused, circuit_open_until, warmup_until').eq('account_id', accountId).eq('connection_id', connectionId).maybeSingle()
    return NextResponse.json({ ...result, guardrail: guardrail ?? null }, { headers: noStore })
  } catch (error) { return errorResponse(error) }
}

export async function POST(request: Request, context: Context) {
  try {
    const { connectionId } = await context.params
    const { accountId, adminDb } = await requireOpenWASessionAdmin()
    const body = await request.json() as Record<string, unknown>
    if (body.action === 'reconnect') return NextResponse.json(await reconnectOpenWAConnection(adminDb, accountId, connectionId), { headers: noStore })
    if (body.action === 'pause' || body.action === 'resume') {
      const paused = body.action === 'pause'
      const { data: connection, error: connectionError } = await adminDb.from('whatsapp_connections').select('id').eq('id', connectionId).eq('account_id', accountId).eq('provider', 'openwa').maybeSingle()
      if (connectionError || !connection) throw new WhatsAppTransportError('invalid_request', 'OpenWA connection was not found for this account', connectionError)
      const { error } = await adminDb.from('whatsapp_connection_guardrails').upsert({ connection_id: connectionId, account_id: accountId, manual_paused: paused, updated_at: new Date().toISOString() }, { onConflict: 'connection_id' })
      if (error) throw new WhatsAppTransportError('retryable_provider_failure', 'Could not update OpenWA emergency pause', error)
      await adminDb.from('whatsapp_guardrail_events').insert({ account_id: accountId, connection_id: connectionId, workload: 'manual', decision: paused ? 'paused' : 'resumed', reason: 'admin_emergency_control' })
      return NextResponse.json({ connectionId, manualPaused: paused }, { headers: noStore })
    }
    throw new WhatsAppTransportError('invalid_request', 'Unsupported OpenWA session action')
  } catch (error) { return errorResponse(error) }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const { connectionId } = await context.params
    const { accountId, adminDb } = await requireOpenWASessionAdmin()
    return NextResponse.json(await logoutOpenWAConnection(adminDb, accountId, connectionId), { headers: noStore })
  } catch (error) { return errorResponse(error) }
}
