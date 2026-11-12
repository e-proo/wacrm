import { randomUUID } from 'crypto'
import { NextResponse } from 'next/server'

import { encrypt } from '@/lib/whatsapp/encryption'
import { validateOpenWABaseUrl } from '@/lib/whatsapp/transport/openwa/client'
import { openWAPilotEnforcementEnabled } from '@/lib/whatsapp/transport/guardrails'
import { requireOpenWASessionAdmin } from '@/lib/whatsapp/transport/openwa/session-auth'
import { resolveOpenWAClient } from '@/lib/whatsapp/transport/openwa/credentials'
import { normalizeOpenWAConnectionState } from '@/lib/whatsapp/transport/openwa/session-lifecycle'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

// Creating the gateway session and starting its browser are two separate
// bounded operations; avoid cutting off the successful remote create.
export const maxDuration = 120

const noStore = { 'Cache-Control': 'no-store, private, max-age=0' }

function errorResponse(error: unknown, diagnostics?: { stage?: string; reconciliation_required?: boolean }) {
  // Only intentionally classified transport errors may be shown to clients.
  // Raw Supabase/provider exceptions can contain credentials or private URLs.
  const message = error instanceof WhatsAppTransportError ? error.message : 'OpenWA session request failed'
  const code = error instanceof WhatsAppTransportError ? error.code : 'retryable_provider_failure'
  const status = code === 'authentication_or_configuration' ? 403
    : code === 'invalid_request' ? 400
    : code === 'connection_restricted' || code === 'ambiguous_outcome' ? 409
    : code === 'rate_limited' ? 429 : 502
  return NextResponse.json({ error: message, code, ...diagnostics }, { status, headers: noStore })
}

export async function GET() {
  try {
    const { accountId, userDb, adminDb } = await requireOpenWASessionAdmin()
    const { data, error } = await userDb
      .from('whatsapp_connections')
      .select('id, display_name, phone_identity, status, session_id, instance_id, engine, provider_metadata, connected_at, disconnected_at, restricted_at, created_at, updated_at')
      .eq('account_id', accountId)
      .eq('provider', 'openwa')
      .is('archived_at', null)
      .order('created_at', { ascending: false })
    if (error) throw new WhatsAppTransportError('retryable_provider_failure', 'Failed to load OpenWA connections', error)
    // Expose only the scoped pause state to authorized admins; no hashes.
    const { data: guardrails, error: guardrailError } = await adminDb
      .from('whatsapp_connection_guardrails')
      .select('connection_id, manual_paused')
      .eq('account_id', accountId)
    if (guardrailError) throw new WhatsAppTransportError('retryable_provider_failure', 'Failed to load OpenWA emergency stop state', guardrailError)
    const pauseByConnection = new Map<string, boolean>((guardrails ?? []).map((row) => [row.connection_id, row.manual_paused === true] as const))
    // A new OpenWA session without a guardrail row is fail-closed: the UI
    // must not claim sending is enabled before explicit TEST pilot setup.
    const connections = (data ?? []).map((row) => ({ ...row, guardrail: { manual_paused: pauseByConnection.get(row.id) !== false } }))
    let devMode = false
    try { devMode = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').hostname === 'pqirsnfupofhulmewakq.supabase.co' }
    catch { /* TEST-only pilot controls remain hidden */ }
    return NextResponse.json({ connections, pilot: { enforced: openWAPilotEnforcementEnabled(), devMode } }, { headers: noStore })
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
    if (!baseUrl || !apiKey) throw new WhatsAppTransportError('invalid_request', 'OpenWA base URL and API key are required')

    const allowedHosts = (process.env.OPENWA_ALLOWED_HOSTS ?? '').split(',').map((value) => value.trim()).filter(Boolean)
    const validatedUrl = validateOpenWABaseUrl(baseUrl, allowedHosts)
    // The real OpenWA gateway generates its own session ID. The name must be
    // deterministic for manual reconciliation if a create request times out.
    const connectionId = randomUUID()
    const sessionName = `wacrm-${connectionId.replace(/-/g, '')}`
    if (body.engine !== undefined) {
      throw new WhatsAppTransportError('invalid_request', 'OpenWA engine is selected in the gateway deployment, not per session')
    }

    const { error: connectionError } = await adminDb.from('whatsapp_connections').insert({
      id: connectionId,
      account_id: accountId,
      provider: 'openwa',
      display_name: displayName || 'WhatsApp Web',
      status: 'creating',
      session_id: null,
      engine: null,
    })
    if (connectionError) throw new WhatsAppTransportError('retryable_provider_failure', 'Failed to create OpenWA connection', connectionError)

    let remoteCreateAttempted = false
    let stage: 'credentials' | 'gateway_create' | 'save_created' | 'gateway_start' | 'save_started' = 'credentials'
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
      stage = 'gateway_create'
      remoteCreateAttempted = true
      const created = await client.createSession({ name: sessionName, correlationId: connectionId })
      stage = 'save_created'
      const { error: createdUpdateError } = await adminDb
        .from('whatsapp_connections')
        .update({ session_id: created.sessionId, status: normalizeOpenWAConnectionState(created.status), phone_identity: created.phoneIdentity ?? null })
        .eq('id', connectionId).eq('account_id', accountId).eq('provider', 'openwa')
      if (createdUpdateError) throw createdUpdateError

      // OpenWA returns "created" after POST /sessions; an explicit start is
      // necessary before it will issue a QR code.
      stage = 'gateway_start'
      const started = await client.startSession(created.sessionId!, connectionId)
      const status = normalizeOpenWAConnectionState(started.status)
      stage = 'save_started'
      const { error: updateError } = await adminDb
        .from('whatsapp_connections')
        .update({ status, phone_identity: started.phoneIdentity ?? null })
        .eq('id', connectionId).eq('account_id', accountId).eq('provider', 'openwa')
      if (updateError) throw updateError

      return NextResponse.json({ connection: { id: connectionId, session_id: created.sessionId, status, engine: null } }, { status: 201, headers: noStore })
    } catch (error) {
      // A successful POST may have created a remote session even if the
      // response timed out, and a start failure may leave it running.
      // Record only safe error category/stage, retain credentials for
      // operator reconciliation, never automatically retry POST /sessions.
      const safeCode = error instanceof WhatsAppTransportError ? error.code : 'retryable_provider_failure'
      if (remoteCreateAttempted) {
        const { error: persistError } = await adminDb.from('whatsapp_connections').update({
          status: 'failed',
          provider_metadata: {
            onboarding_stage: stage,
            onboarding_failure_code: safeCode,
            onboarding_reconciliation_required: true,
          },
        }).eq('id', connectionId).eq('account_id', accountId).eq('provider', 'openwa')
        if (persistError) {
          console.error('[openwa-session] could not persist onboarding outcome', { stage, code: safeCode })
        }
      } else {
        await adminDb.from('whatsapp_connections').delete()
          .eq('id', connectionId).eq('account_id', accountId).eq('provider', 'openwa')
      }
      return errorResponse(error, { stage, reconciliation_required: remoteCreateAttempted })
    }
  } catch (error) {
    return errorResponse(error)
  }
}
