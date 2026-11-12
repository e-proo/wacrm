import { NextResponse } from 'next/server'

import { canonicalOpenWAPilotRecipient, isOpenWATestProject, openWAPilotEnforcementEnabled, openWAPilotRecipientHash } from '@/lib/whatsapp/transport/guardrails'
import { requireOpenWASessionAdmin } from '@/lib/whatsapp/transport/openwa/session-auth'
import { resolveOpenWAPilotRecipientForGrant } from '@/lib/whatsapp/transport/openwa/pilot-recipient'
import { refreshOpenWAConnectionStatus } from '@/lib/whatsapp/transport/openwa/session-lifecycle'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

type Context = { params: Promise<{ connectionId: string }> }
const noStore = { 'Cache-Control': 'private, no-store, max-age=0' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_HOURLY = 3
const MAX_DAILY = 10
const MAX_FIRST_TOUCH = 1
const MIN_INTERVAL = 15000

type Db = Awaited<ReturnType<typeof requireOpenWASessionAdmin>>['adminDb']

function deny(message: string, status: number, code = 'pilot_restricted') {
  return NextResponse.json({ error: message, code }, { status, headers: noStore })
}

function fail(error: unknown) {
  if (error instanceof WhatsAppTransportError && error.code === 'authentication_or_configuration') {
    return deny('Admin access is required', 403, 'unauthorized')
  }
  if (error instanceof WhatsAppTransportError && error.code === 'invalid_request') {
    return deny('Invalid pilot request', 400, 'invalid_request')
  }
  if (error instanceof WhatsAppTransportError && error.code === 'connection_restricted') {
    return deny('Pilot action blocked by safety checks', 409)
  }
  // No SQL/provider errors, secrets or recipient values in a browser response.
  return deny('OpenWA pilot control could not be completed; inspect server diagnostics', 502, 'pilot_control_error')
}

function assertTestConnectionId(connectionId: string) {
  if (!isOpenWATestProject() || !UUID.test(connectionId)) {
    throw new WhatsAppTransportError('connection_restricted', 'DEV pilot controls are available only on TEST')
  }
}

function checkDb(error: { code?: string } | null, step: string) {
  if (error) {
    console.error('[openwa-dev-pilot] database action failed', { step, code: /^[A-Za-z0-9_]{1,12}$/.test(error.code ?? '') ? error.code : 'unknown' })
    throw new WhatsAppTransportError('retryable_provider_failure', 'OpenWA pilot storage operation failed')
  }
}

async function snapshot(db: Db, accountId: string, connectionId: string) {
  const { data: connection, error: ce } = await db.from('whatsapp_connections')
    .select('id, status, session_id, phone_identity, archived_at')
    .eq('id', connectionId).eq('account_id', accountId).eq('provider', 'openwa')
    .maybeSingle()
  checkDb(ce, 'connection')
  if (!connection || connection.archived_at) {
    throw new WhatsAppTransportError('connection_restricted', 'Pilot connection missing or unavailable')
  }
  const { data: guard, error: ge } = await db.from('whatsapp_connection_guardrails')
    .select('manual_paused,pilot_enabled,hourly_cap,daily_cap,first_touch_daily_cap,minimum_interval_ms,jitter_ms,warmup_hourly_cap,warmup_daily_cap')
    .eq('connection_id', connectionId).eq('account_id', accountId).maybeSingle()
  checkDb(ge, 'guardrail')
  // Newly created sessions have no guardrails until an admin prepares them.
  // A missing row must not silently inherit permissive schema defaults.
  const configured = Boolean(guard)
  const safeGuard = guard ?? {
    manual_paused: true, pilot_enabled: true, hourly_cap: MAX_HOURLY, daily_cap: MAX_DAILY,
    first_touch_daily_cap: MAX_FIRST_TOUCH, minimum_interval_ms: MIN_INTERVAL,
    jitter_ms: 3000, warmup_hourly_cap: MAX_HOURLY, warmup_daily_cap: MAX_DAILY,
  }

  const { count: grants, error: ae } = await db.from('whatsapp_openwa_pilot_allowlist')
    .select('id', { count: 'exact', head: true }).eq('account_id', accountId)
    .eq('connection_id', connectionId).eq('active', true).gt('expires_at', new Date().toISOString())
  checkDb(ae, 'grants')
  const { count: manualGrants, error: manualError } = await db.from('whatsapp_openwa_pilot_allowlist')
    .select('id', { count: 'exact', head: true }).eq('account_id', accountId)
    .eq('connection_id', connectionId).eq('active', true).eq('workload', 'manual')
    .gt('expires_at', new Date().toISOString())
  checkDb(manualError, 'manual-grants')
  const { count: pending, error: me } = await db.from('messages')
    .select('id', { count: 'exact', head: true }).eq('provider', 'openwa')
    .eq('connection_id', connectionId).eq('status', 'sending').is('provider_message_id', null)
  checkDb(me, 'pending')
  let duplicates = 0
  if (connection.phone_identity) {
    const { count, error: de } = await db.from('whatsapp_connections')
      .select('id', { count: 'exact', head: true }).eq('account_id', accountId)
      .eq('provider', 'openwa').eq('phone_identity', connection.phone_identity)
      .in('status', ['ready', 'connected']).is('archived_at', null)
    checkDb(de, 'duplicates')
    duplicates = count ?? 0
  }
  // Emergency stop and status must remain available even if the runtime
  // pilot flag was misconfigured. Unknown values deny activation/sends.
  let enforced = false
  try { enforced = openWAPilotEnforcementEnabled() } catch { enforced = false }
  return { connection, guard: safeGuard, configured, grants: grants ?? 0, manualGrants: manualGrants ?? 0,
    pending: pending ?? 0, duplicates, enforced,
    active: configured && safeGuard.pilot_enabled && enforced && !safeGuard.manual_paused && (grants ?? 0) > 0 }
}

function safeStatus(s: Awaited<ReturnType<typeof snapshot>>) {
  return { connectionId: s.connection.id, configured: s.configured,
    status: s.connection.status, enforced: s.enforced, pilot_enabled: s.guard.pilot_enabled,
    active: s.active, paused: s.guard.manual_paused, guardrails: {
      hourly_cap: s.guard.hourly_cap, daily_cap: s.guard.daily_cap,
      first_touch_daily_cap: s.guard.first_touch_daily_cap,
      minimum_interval_ms: s.guard.minimum_interval_ms, jitter_ms: s.guard.jitter_ms,
      warmup_hourly_cap: s.guard.warmup_hourly_cap, warmup_daily_cap: s.guard.warmup_daily_cap,
    },
    active_admissions: s.grants, unsettled_outbound: s.pending, same_identity_ready_connections: s.duplicates }
}

function requireLimits(s: Awaited<ReturnType<typeof snapshot>>) {
  const g = s.guard
  if (g.hourly_cap > MAX_HOURLY || g.daily_cap > MAX_DAILY ||
      g.first_touch_daily_cap > MAX_FIRST_TOUCH || g.minimum_interval_ms < MIN_INTERVAL ||
      g.warmup_hourly_cap > MAX_HOURLY || g.warmup_daily_cap > MAX_DAILY) {
    throw new WhatsAppTransportError('connection_restricted', 'Unsafe pilot limits')
  }
}

function int(value: unknown, min: number, max: number, name: string) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new WhatsAppTransportError('invalid_request', `Invalid ${name}`)
  }
  return value
}

export async function GET(_request: Request, context: Context) {
  try {
    const { connectionId } = await context.params
    const { accountId, adminDb } = await requireOpenWASessionAdmin()
    assertTestConnectionId(connectionId)
    return NextResponse.json(await snapshot(adminDb, accountId, connectionId).then(safeStatus), { headers: noStore })
  } catch (error) { return fail(error) }
}

export async function POST(request: Request, context: Context) {
  try {
    const { connectionId } = await context.params
    const { accountId, adminDb, user } = await requireOpenWASessionAdmin()
    assertTestConnectionId(connectionId)
    const body = await request.json() as Record<string, unknown>
    const action = body.action
    if (!['prepare', 'limits', 'grant', 'activate', 'stop', 'disable', 'enable'].includes(String(action))) return deny('Unknown pilot action', 400)
    const s = await snapshot(adminDb, accountId, connectionId)

    if (action === 'disable' || action === 'enable') {
      const enable = action === 'enable'
      if (!enable) {
        if (body.confirm_normal_sending !== true) return deny('Confirm ordinary sending for this connection', 400)
        if (s.pending !== 0 || !s.connection.session_id || !['ready', 'connected'].includes(s.connection.status)) {
          return deny('Reconcile unsettled sends and restore a ready session before disabling Pilot', 409)
        }
        if (s.duplicates > 1 && body.ack_duplicate_sessions !== true) {
          return deny('Review duplicate sessions before enabling ordinary sending', 409)
        }
        // Read the provider status, never create or reconnect another session.
        const live = await refreshOpenWAConnectionStatus(adminDb, accountId, connectionId)
        if (!['ready', 'connected'].includes(live.status)) {
          return deny('The OpenWA gateway is not ready for ordinary sending', 409, 'pilot_gateway_not_ready')
        }
      }
      // Transactional, tenant-scoped mode + pause + cap + revoke + audit.
      const { data: outcome, error } = await adminDb.rpc('set_openwa_test_pilot_mode', {
        p_account_id: accountId, p_connection_id: connectionId, p_actor: user.id,
        p_pilot_enabled: enable,
        p_confirm_normal_sending: !enable && body.confirm_normal_sending === true,
        p_ack_duplicate_sessions: body.ack_duplicate_sessions === true,
      })
      checkDb(error, 'mode-toggle')
      if ((outcome as { updated?: boolean } | null)?.updated !== true) {
        return deny('Pilot mode changed or safety checks blocked this action; refresh the connection', 409, 'pilot_state_changed')
      }
      return NextResponse.json(safeStatus(await snapshot(adminDb, accountId, connectionId)), { headers: noStore })
    }

    if (action === 'prepare') {
      if (!s.guard.pilot_enabled) return deny('Enable Pilot before preparing this connection', 409)
      if (body.confirm_prepare !== true) return deny('Confirm connection-specific pilot preparation', 400)
      if (!s.connection.session_id || !['ready', 'connected'].includes(s.connection.status) || s.pending !== 0 || s.grants !== 0) {
        return deny('Pilot preparation requires an existing ready session without unsettled sends or active grants', 409)
      }
      const { error } = await adminDb.from('whatsapp_connection_guardrails')
        .upsert({ connection_id: connectionId, account_id: accountId,
          manual_paused: true, hourly_cap: MAX_HOURLY, daily_cap: MAX_DAILY,
          first_touch_daily_cap: MAX_FIRST_TOUCH, minimum_interval_ms: MIN_INTERVAL,
          jitter_ms: 3000, warmup_until: new Date(Date.now() + 7 * 86400000).toISOString(),
          warmup_hourly_cap: MAX_HOURLY, warmup_daily_cap: MAX_DAILY,
          failure_window_minutes: 15, failure_min_attempts: 2,
          failure_rate_threshold: 0.5, updated_at: new Date().toISOString() },
        { onConflict: 'connection_id' })
      checkDb(error, 'prepare')
      const { error: auditError } = await adminDb.from('whatsapp_guardrail_events')
        .insert({ account_id: accountId, connection_id: connectionId, workload: 'manual',
          decision: 'paused', reason: 'ow13_dev_pilot_admin_prepare' })
      checkDb(auditError, 'prepare-audit')
      return NextResponse.json(safeStatus(await snapshot(adminDb, accountId, connectionId)), { headers: noStore })
    }

    if (action === 'stop') {
      // STOP also works before an admin prepares this new session.
      const { error: pe } = await adminDb.from('whatsapp_connection_guardrails')
        .upsert({ connection_id: connectionId, account_id: accountId,
          manual_paused: true,
          ...(!s.configured ? { hourly_cap: MAX_HOURLY, daily_cap: MAX_DAILY,
            first_touch_daily_cap: MAX_FIRST_TOUCH, minimum_interval_ms: MIN_INTERVAL,
            jitter_ms: 3000, warmup_hourly_cap: MAX_HOURLY, warmup_daily_cap: MAX_DAILY } : {}),
          updated_at: new Date().toISOString() }, { onConflict: 'connection_id' })
      checkDb(pe, 'stop-pause')
      const { error: re } = await adminDb.from('whatsapp_openwa_pilot_allowlist')
        .update({ active: false }).eq('account_id', accountId).eq('connection_id', connectionId).eq('active', true)
      checkDb(re, 'stop-revoke')
      const { error: auditError } = await adminDb.from('whatsapp_guardrail_events')
        .insert({ account_id: accountId, connection_id: connectionId, workload: 'manual',
          decision: 'paused', reason: 'ow13_dev_pilot_admin_stop' })
      checkDb(auditError, 'stop-audit')
      return NextResponse.json({ ...safeStatus(await snapshot(adminDb, accountId, connectionId)), stopped: true }, { headers: noStore })
    }

    if (action === 'limits') {
      if (!s.guard.pilot_enabled || !s.configured || !s.guard.manual_paused) return deny('Pause the pilot before changing limits', 409)
      const hourly = int(body.hourly_cap, 1, MAX_HOURLY, 'hourly')
      const daily = int(body.daily_cap, 1, MAX_DAILY, 'daily')
      const firstTouch = int(body.first_touch_daily_cap, 0, MAX_FIRST_TOUCH, 'first touch')
      const interval = int(body.minimum_interval_ms, MIN_INTERVAL, 600000, 'pacing')
      const jitter = int(body.jitter_ms, 0, 600000, 'jitter')
      const { data: updated, error } = await adminDb.from('whatsapp_connection_guardrails')
        .update({ hourly_cap: hourly, daily_cap: daily, first_touch_daily_cap: firstTouch,
          minimum_interval_ms: interval, jitter_ms: jitter,
          warmup_hourly_cap: hourly, warmup_daily_cap: daily, updated_at: new Date().toISOString() })
        .eq('account_id', accountId).eq('connection_id', connectionId)
        .eq('manual_paused', true).select('connection_id').maybeSingle()
      checkDb(error, 'limits')
      if (!updated) return deny('Pilot state changed; retry after refresh', 409)
      return NextResponse.json(safeStatus(await snapshot(adminDb, accountId, connectionId)), { headers: noStore })
    }

    if (action === 'grant') {
      if (!s.configured || !s.guard.pilot_enabled || !s.enforced || !s.guard.manual_paused) return deny('Enable the server-side gate and pause before granting a recipient', 409)
      if (body.consent_confirmed !== true) return deny('Recipient consent is required', 400)
      if (s.duplicates > 1 && body.ack_duplicate_sessions !== true) return deny('Duplicate connection identity must be reviewed', 409)
      if (!s.connection.session_id || !['ready','connected'].includes(s.connection.status) || s.pending !== 0 || s.grants !== 0) {
        return deny('Pilot session is not ready, has unsettled sends or already has a grant', 409)
      }
      requireLimits(s)
      const rawRecipient = typeof body.recipient === 'string' ? body.recipient.trim() : ''
      if (!canonicalOpenWAPilotRecipient(rawRecipient)) return deny('Invalid OpenWA recipient identity', 400)
      // The inbound chat may have a verified @lid identity even when the
      // admin types its contact's phone number. Resolve the exact same
      // session-scoped chat that the send core will use, not a guessed @c.us.
      const resolvedRecipient = await resolveOpenWAPilotRecipientForGrant(
        adminDb, accountId, connectionId, rawRecipient,
      )
      const hash = openWAPilotRecipientHash(accountId, connectionId, resolvedRecipient.recipient)
      if (!hash) return deny('Invalid recipient', 400)
      const hours = int(body.hours ?? 4, 1, 4, 'expiry')
      const now = new Date()
      const { error } = await adminDb.from('whatsapp_openwa_pilot_allowlist')
        .upsert({ account_id: accountId, connection_id: connectionId,
          recipient_hash: hash, workload: 'manual', active: true, approved_by: user.id,
          approved_at: now.toISOString(), expires_at: new Date(now.getTime() + hours * 3600000).toISOString() },
        { onConflict: 'account_id,connection_id,recipient_hash,workload' })
      checkDb(error, 'grant')
      return NextResponse.json({
        ...safeStatus(await snapshot(adminDb, accountId, connectionId)),
        recipient_identity_source: resolvedRecipient.source,
      }, { headers: noStore })
    }

    if (action === 'activate') {
      if (!s.configured || !s.guard.pilot_enabled || !s.enforced || !s.guard.manual_paused || s.grants !== 1 || s.manualGrants !== 1 || s.pending !== 0 ||
          !s.connection.session_id || !['ready','connected'].includes(s.connection.status)) {
        return deny('Pilot activation requires enforce mode, one approval, paused/ready connection and zero unsettled sends', 409)
      }
      if (s.duplicates > 1 && body.ack_duplicate_sessions !== true) return deny('Duplicate sessions need explicit review', 409)
      requireLimits(s)
      // WACRM DB readiness can be stale after a Cloudflare URL rotation.
      // Make a read-only provider-native status check immediately before
      // lifting the emergency pause. Never create/retry a gateway session.
      const live = await refreshOpenWAConnectionStatus(adminDb, accountId, connectionId)
      if (!['ready', 'connected'].includes(live.status)) {
        return deny('The existing OpenWA gateway session is not ready; verify or update the tunnel URL first', 409, 'pilot_gateway_not_ready')
      }
      // Re-check pause/grant after the network call, since another admin may
      // have revoked the approval or stopped the pilot while it was pending.
      const latest = await snapshot(adminDb, accountId, connectionId)
      if (!latest.configured || !latest.guard.pilot_enabled || !latest.enforced || !latest.guard.manual_paused ||
        latest.grants !== 1 || latest.manualGrants !== 1 || latest.pending !== 0) {
        return deny('Pilot state changed during verification; refresh and review', 409, 'pilot_state_changed')
      }
      requireLimits(latest)
      const { data: updated, error } = await adminDb.from('whatsapp_connection_guardrails')
        .update({ manual_paused: false, updated_at: new Date().toISOString() })
        .eq('account_id', accountId).eq('connection_id', connectionId).eq('manual_paused', true)
        .select('connection_id').maybeSingle()
      checkDb(error, 'activate')
      if (!updated) return deny('Pilot state changed; refresh first', 409)
      const { error: auditError } = await adminDb.from('whatsapp_guardrail_events')
        .insert({ account_id: accountId, connection_id: connectionId, workload: 'manual',
          decision: 'resumed', reason: 'ow13_dev_pilot_admin_activate' })
      if (auditError) {
        // Compensate: audit failure must not leave an untracked activated cohort.
        await adminDb.from('whatsapp_connection_guardrails').update({ manual_paused: true })
          .eq('account_id', accountId).eq('connection_id', connectionId)
        checkDb(auditError, 'activate-audit')
      }
      return NextResponse.json(safeStatus(await snapshot(adminDb, accountId, connectionId)), { headers: noStore })
    }
    return deny('Unsupported pilot action', 400)
  } catch (error) { return fail(error) }
}
