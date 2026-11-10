import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'

import { encrypt } from '@/lib/whatsapp/encryption'
import { resolveOpenWAClient } from '@/lib/whatsapp/transport/openwa/credentials'

import { requireOpenWASessionAdmin } from '@/lib/whatsapp/transport/openwa/session-auth'
import { logoutOpenWAConnection, reconnectOpenWAConnection, refreshOpenWAConnectionStatus } from '@/lib/whatsapp/transport/openwa/session-lifecycle'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

const noStore = { 'Cache-Control': 'no-store, private, max-age=0' }
type Context = { params: Promise<{ connectionId: string }> }

function errorResponse(error: unknown) {
  const message = error instanceof WhatsAppTransportError ? error.message : 'OpenWA session request failed'
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
    const { accountId, adminDb, user } = await requireOpenWASessionAdmin()
    const body = await request.json() as Record<string, unknown>
    if (body.action === 'configure_webhook') {
      const webhookUrl = process.env.OPENWA_WEBHOOK_URL?.trim()
      if (!webhookUrl) {
        throw new WhatsAppTransportError('invalid_request', 'Configure OPENWA_WEBHOOK_URL with your public WACRM webhook URL first')
      }
      const { data: connection, error: connectionError } = await adminDb.from('whatsapp_connections')
        .select('session_id').eq('id', connectionId).eq('account_id', accountId).eq('provider', 'openwa').maybeSingle()
      if (connectionError || !connection?.session_id) throw new WhatsAppTransportError('invalid_request', 'OpenWA session was not found for this account', connectionError)

      const { credentials, client } = await resolveOpenWAClient(adminDb, accountId, connectionId)
      const secret = credentials.webhookSecret ?? randomBytes(32).toString('hex')
      if (!credentials.webhookSecret) {
        // Persist the signing key before enabling delivery: there must never
        // be a window in which OpenWA sends events WACRM cannot verify.
        const { error: secretError } = await adminDb.from('whatsapp_connection_credentials')
          .update({ webhook_secret_encrypted: encrypt(secret) })
          .eq('connection_id', connectionId).eq('account_id', accountId).eq('provider', 'openwa')
        if (secretError) throw new WhatsAppTransportError('retryable_provider_failure', 'Failed to save OpenWA webhook signing secret', secretError)
      }
      await client.configureWebhook(connection.session_id, webhookUrl, secret, connectionId)
      return NextResponse.json({ enabled: true }, { headers: noStore })
    }
    if (body.action === 'remove_from_wacrm') {
      // Admin-only, local removal. Do NOT issue /logout or remote DELETE:
      // the OpenWA daemon may be offline; this operation revokes only WACRM
      // credentials while keeping provider message IDs, receipts and audit.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectionId)) {
        return NextResponse.json({ error: 'Invalid OpenWA connection ID', code: 'invalid_request' }, { status: 400, headers: noStore })
      }
      const { data: outcome, error: archiveError } = await adminDb.rpc('archive_openwa_connection', {
        p_account_id: accountId,
        p_connection_id: connectionId,
        p_actor_id: user.id,
      })
      if (archiveError) {
        console.error('[openwa-session] archive operation failed', {
          dbCode: typeof archiveError.code === 'string' && /^[0-9A-Z]{5}$/.test(archiveError.code) ? archiveError.code : 'unknown',
        })
        return NextResponse.json({ error: 'Could not remove OpenWA session from WACRM', code: 'archive_failed' }, { status: 502, headers: noStore })
      }
      if (outcome === 'pending_sends' || outcome === 'pending_webhooks') {
        return NextResponse.json({
          error: outcome === 'pending_sends'
            ? 'Pending OpenWA sends require reconciliation before removal'
            : 'Unfinished signed OpenWA events require reconciliation before removal',
          code: outcome,
        }, { status: 409, headers: noStore })
      }
      if (outcome === 'not_found') {
        return NextResponse.json({ error: 'OpenWA session not found', code: outcome }, { status: 404, headers: noStore })
      }
      if (outcome === 'archived' || outcome === 'already_archived') {
        return NextResponse.json({ removed: true, already_removed: outcome === 'already_archived' }, { headers: noStore })
      }
      return NextResponse.json({ error: 'OpenWA session could not be removed', code: 'archive_rejected' }, { status: 400, headers: noStore })
    }

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
