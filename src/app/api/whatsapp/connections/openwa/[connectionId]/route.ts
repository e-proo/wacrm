import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'

import { encrypt } from '@/lib/whatsapp/encryption'
import { OpenWAClient, validateOpenWABaseUrl, validateOpenWAWebhookUrl } from '@/lib/whatsapp/transport/openwa/client'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'
import { resolveOpenWAClient } from '@/lib/whatsapp/transport/openwa/credentials'

import { requireOpenWASessionAdmin } from '@/lib/whatsapp/transport/openwa/session-auth'
import { logoutOpenWAConnection, reconnectOpenWAConnection, refreshOpenWAConnectionStatus } from '@/lib/whatsapp/transport/openwa/session-lifecycle'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

const noStore = { 'Cache-Control': 'no-store, private, max-age=0' }
type Context = { params: Promise<{ connectionId: string }> }

function errorResponse(error: unknown, stage?: string) {
  const message = error instanceof WhatsAppTransportError ? error.message : 'OpenWA session request failed'
  const code = error instanceof WhatsAppTransportError ? error.code : 'retryable_provider_failure'
  // Upstream HTTP 404 or missing configuration must not appear as a missing WACRM route.
  const status = code === 'authentication_or_configuration' ? 403
    : code === 'invalid_request' ? 400
    : code === 'connection_restricted' || code === 'ambiguous_outcome' ? 409
    : code === 'rate_limited' ? 429 : 502
  return NextResponse.json({ error: message, code, ...(stage ? { stage } : {}) }, { status, headers: noStore })
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
  let stage: string | undefined
  try {
    const { connectionId } = await context.params
    const { accountId, adminDb, user } = await requireOpenWASessionAdmin()
    const body = await request.json() as Record<string, unknown>
    if (body.action === 'update_gateway' || body.action === 'update_settings') {
      const updateName = body.action === 'update_settings' && body.display_name !== undefined
      const updateGateway = body.action === 'update_gateway' || body.base_url !== undefined || body.api_key !== undefined
      if (!updateName && !updateGateway) throw new WhatsAppTransportError('invalid_request', 'No session settings changes were provided')
      const displayName = updateName && typeof body.display_name === 'string' ? body.display_name.trim() : ''
      if (updateName && (!displayName || displayName.length > 120)) {
        throw new WhatsAppTransportError('invalid_request', 'Enter a session name of up to 120 characters')
      }
      // Gateway rotation remains restricted to the pinned TEST project, but
      // renaming an existing tenant-scoped session is independent of Pilot.
      if (updateGateway && !isOpenWATestProject()) {
        throw new WhatsAppTransportError('connection_restricted', 'Gateway rotation is only available on TEST')
      }
      const { data: connection, error: lookupError } = await adminDb.from('whatsapp_connections')
        .select('session_id').eq('id', connectionId).eq('account_id', accountId)
        .eq('provider', 'openwa').is('archived_at', null).maybeSingle()
      if (lookupError || !connection) {
        throw new WhatsAppTransportError('connection_restricted', 'OpenWA connection was not found for this account', lookupError)
      }
      if (updateGateway) {
        // Verify the same upstream session read-only; never POST /sessions or /start.
        if (!connection.session_id) throw new WhatsAppTransportError('connection_restricted', 'Existing OpenWA session identity is required to update its gateway')
        const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : ''
        const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
        if (!baseUrl || !apiKey) throw new WhatsAppTransportError('invalid_request', 'Enter the new OpenWA URL and API key')
        const allowedHosts = (process.env.OPENWA_ALLOWED_HOSTS ?? '').split(',').map((item) => item.trim()).filter(Boolean)
        const verifiedUrl = validateOpenWABaseUrl(baseUrl, allowedHosts)
        const client = new OpenWAClient({ baseUrl: verifiedUrl.toString(), apiKey, allowedHosts, timeoutMs: 8000 })
        const existingSession = await client.getSessionStatus(connection.session_id, connectionId)
        if (existingSession.sessionId !== connection.session_id) {
          throw new WhatsAppTransportError('connection_restricted', 'The new gateway did not confirm this exact OpenWA session')
        }
        const { data: updated, error: writeError } = await adminDb.from('whatsapp_connection_credentials')
          .update({ base_url: verifiedUrl.origin + (verifiedUrl.pathname === '/' ? '' : verifiedUrl.pathname),
            api_key_encrypted: encrypt(apiKey), updated_at: new Date().toISOString() })
          .eq('connection_id', connectionId).eq('account_id', accountId).eq('provider', 'openwa')
          .select('connection_id').maybeSingle()
        if (writeError || !updated) {
          throw new WhatsAppTransportError('retryable_provider_failure', 'Could not update existing OpenWA gateway credentials', writeError)
        }
      }
      if (updateName) {
        const { data: renamed, error: nameError } = await adminDb.from('whatsapp_connections')
          .update({ display_name: displayName }).eq('id', connectionId).eq('account_id', accountId)
          .eq('provider', 'openwa').is('archived_at', null).select('id').maybeSingle()
        if (nameError || !renamed) {
          // Gateway writes, if requested, may already have succeeded.
          throw new WhatsAppTransportError('retryable_provider_failure',
            'Could not update the session name; refresh the connection before retrying', nameError)
        }
      }
      return NextResponse.json({ updated: true, sessionId: connection.session_id }, { headers: noStore })
    }

    if (body.action === 'configure_webhook') {
      stage = 'webhook_url'
      const supplied = body.webhook_url !== undefined
      if (supplied && !isOpenWATestProject()) {
        throw new WhatsAppTransportError('connection_restricted', 'Custom webhook URLs are editable on TEST only')
      }
      const requested = typeof body.webhook_url === 'string' ? body.webhook_url.trim() : ''
      if (supplied) {
        if (!requested) throw new WhatsAppTransportError('invalid_request', 'Enter a public HTTPS WACRM webhook URL')
        // The callback receives customer data; it must be a valid WACRM route.
        validateOpenWAWebhookUrl(requested)
      }
      stage = 'session_lookup'
      const { data: connection, error: connectionError } = await adminDb.from('whatsapp_connections')
        .select('session_id').eq('id', connectionId).eq('account_id', accountId).eq('provider', 'openwa')
        .is('archived_at', null).maybeSingle()
      if (connectionError) throw new WhatsAppTransportError('retryable_provider_failure', 'Failed to load the OpenWA session', connectionError)
      if (!connection) return NextResponse.json({ error: 'OpenWA session was not found for this account', code: 'not_found' }, { status: 404, headers: noStore })
      if (!connection.session_id) throw new WhatsAppTransportError('connection_restricted', 'OpenWA session ID requires reconciliation before configuring webhooks')

      stage = 'credentials'
      const { credentials, client } = await resolveOpenWAClient(adminDb, accountId, connectionId)
      const webhookUrl = requested || credentials.webhookUrl || process.env.OPENWA_WEBHOOK_URL?.trim() || ''
      if (!webhookUrl) throw new WhatsAppTransportError('invalid_request', 'Configure a public WACRM webhook URL first')
      validateOpenWAWebhookUrl(webhookUrl)
      const secret = credentials.webhookSecret ?? randomBytes(32).toString('hex')
      if (!credentials.webhookSecret) {
        // Persist HMAC signing key before enabling provider delivery.
        const { error: secretError } = await adminDb.from('whatsapp_connection_credentials')
          .update({ webhook_secret_encrypted: encrypt(secret) })
          .eq('connection_id', connectionId).eq('account_id', accountId).eq('provider', 'openwa')
        if (secretError) throw new WhatsAppTransportError('retryable_provider_failure', 'Failed to save OpenWA webhook signing secret', secretError)
      }
      stage = 'gateway_registration'
      // This updates a unique existing WACRM callback IN PLACE and verifies
      // OpenWA's list after the PUT/POST; it never silently creates duplicates.
      await client.configureWebhook(connection.session_id, webhookUrl, secret, connectionId)
      if (supplied) {
        stage = 'save_verified_url'
        const { data: saved, error: saveError } = await adminDb.from('whatsapp_connection_credentials')
          .update({ webhook_url: webhookUrl })
          .eq('connection_id', connectionId).eq('account_id', accountId).eq('provider', 'openwa')
          .select('connection_id').maybeSingle()
        if (saveError || !saved) {
          throw new WhatsAppTransportError('retryable_provider_failure',
            'OpenWA confirmed the webhook, but WACRM could not save its URL; refresh before retrying', saveError)
        }
      }
      return NextResponse.json({ enabled: true, synced: true, webhook_url: webhookUrl }, { headers: noStore })
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
      // The pinned TEST pilot may only be activated through its validated
      // admin pilot endpoint. The general resume action would bypass admission
      // readiness checks and could unpause while enforce mode is off.
      const isTestPilotProject = isOpenWATestProject()
      if (body.action === 'resume' && isTestPilotProject) {
        return NextResponse.json({
          error: 'Use the TEST pilot controls to activate this connection safely',
          code: 'pilot_control_required',
        }, { status: 409, headers: noStore })
      }
      const paused = body.action === 'pause'
      const { data: connection, error: connectionError } = await adminDb.from('whatsapp_connections').select('id').eq('id', connectionId).eq('account_id', accountId).eq('provider', 'openwa').maybeSingle()
      if (connectionError || !connection) throw new WhatsAppTransportError('invalid_request', 'OpenWA connection was not found for this account', connectionError)
      const { error } = await adminDb.from('whatsapp_connection_guardrails').upsert({ connection_id: connectionId, account_id: accountId, manual_paused: paused, updated_at: new Date().toISOString() }, { onConflict: 'connection_id' })
      if (error) throw new WhatsAppTransportError('retryable_provider_failure', 'Could not update OpenWA emergency pause', error)
      const { error: auditError } = await adminDb.from('whatsapp_guardrail_events').insert({ account_id: accountId, connection_id: connectionId, workload: 'manual', decision: paused ? 'paused' : 'resumed', reason: 'admin_emergency_control' })
      if (auditError) throw new WhatsAppTransportError('retryable_provider_failure', 'OpenWA pause changed but its audit record could not be saved; refresh the connection state', auditError)
      return NextResponse.json({ connectionId, manualPaused: paused }, { headers: noStore })
    }
    throw new WhatsAppTransportError('invalid_request', 'Unsupported OpenWA session action')
  } catch (error) { return errorResponse(error, stage) }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const { connectionId } = await context.params
    const { accountId, adminDb } = await requireOpenWASessionAdmin()
    return NextResponse.json(await logoutOpenWAConnection(adminDb, accountId, connectionId), { headers: noStore })
  } catch (error) { return errorResponse(error) }
}
