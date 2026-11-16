import { NextResponse } from 'next/server'

import { canonicalOpenWAPilotRecipient, isOpenWATestProject, openWAPilotEnforcementEnabled, openWAPilotRecipientHash } from '@/lib/whatsapp/transport/guardrails'
import { requireOpenWASessionAdmin } from '@/lib/whatsapp/transport/openwa/session-auth'
import { resolveOpenWAPilotRecipientForGrant } from '@/lib/whatsapp/transport/openwa/pilot-recipient'
import { missingPilotCohortCaps, requiredPilotCohortMessages, OPENWA_TEST_PILOT_DEFAULT_MESSAGES_PER_RECIPIENT, OPENWA_TEST_PILOT_MAX_MESSAGES_PER_RECIPIENT, OPENWA_TEST_PILOT_MAX_HOURLY, OPENWA_TEST_PILOT_MAX_DAILY, OPENWA_TEST_PILOT_MAX_FIRST_TOUCH, OPENWA_TEST_PILOT_MIN_INTERVAL_MS } from '@/lib/whatsapp/transport/openwa/pilot-cohort-caps'
import { refreshOpenWAConnectionStatus } from '@/lib/whatsapp/transport/openwa/session-lifecycle'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

type Context = { params: Promise<{ connectionId: string }> }
const noStore = { 'Cache-Control': 'private, no-store, max-age=0' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULT_HOURLY = 3
const DEFAULT_DAILY = 10
const DEFAULT_FIRST_TOUCH = 1
const MAX_HOURLY = OPENWA_TEST_PILOT_MAX_HOURLY
const MAX_DAILY = OPENWA_TEST_PILOT_MAX_DAILY
const MAX_FIRST_TOUCH = OPENWA_TEST_PILOT_MAX_FIRST_TOUCH
const MAX_BATCH_CONTACTS = 10
const MIN_INTERVAL = OPENWA_TEST_PILOT_MIN_INTERVAL_MS

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
    .select('manual_paused,pilot_enabled,hourly_cap,daily_cap,first_touch_daily_cap,minimum_interval_ms,jitter_ms,warmup_hourly_cap,warmup_daily_cap,pilot_agent_hourly_cap,pilot_agent_daily_cap,pilot_manual_hourly_cap,pilot_manual_daily_cap')
    .eq('connection_id', connectionId).eq('account_id', accountId).maybeSingle()
  checkDb(ge, 'guardrail')
  // Newly created sessions have no guardrails until an admin prepares them.
  // A missing row must not silently inherit permissive schema defaults.
  const configured = Boolean(guard)
  const safeGuard = guard ?? {
    manual_paused: true, pilot_enabled: true, hourly_cap: DEFAULT_HOURLY, daily_cap: DEFAULT_DAILY,
    first_touch_daily_cap: DEFAULT_FIRST_TOUCH, minimum_interval_ms: MIN_INTERVAL,
    jitter_ms: 3000, warmup_hourly_cap: DEFAULT_HOURLY, warmup_daily_cap: DEFAULT_DAILY,
    pilot_agent_hourly_cap: null, pilot_agent_daily_cap: null,
    pilot_manual_hourly_cap: null, pilot_manual_daily_cap: null,
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
  const { count: agentGrants, error: agentError } = await db.from('whatsapp_openwa_pilot_allowlist')
    .select('id', { count: 'exact', head: true }).eq('account_id', accountId)
    .eq('connection_id', connectionId).eq('active', true).eq('workload', 'agent')
    .gt('expires_at', new Date().toISOString())
  checkDb(agentError, 'agent-grants')
  const { count: apiGrants, error: apiError } = await db.from('whatsapp_openwa_pilot_allowlist')
    .select('id', { count: 'exact', head: true }).eq('account_id', accountId)
    .eq('connection_id', connectionId).eq('active', true).eq('workload', 'api')
    .gt('expires_at', new Date().toISOString())
  checkDb(apiError, 'api-grants')
  // An administrative API grant is independent of the existing Agent cohort
  // capacity (e.g., 3×33 + one admin is NOT 4×33).
  const cohortGrants = (manualGrants ?? 0) + (agentGrants ?? 0)
  // Display the latest denied attempt to the authenticated session admin.
  // No recipient hash, phone, chat ID, credential or message body reaches UI.
  const { data: lastDenial, error: denialError } = await db
    .from('whatsapp_openwa_pilot_admission_events')
    .select('workload,reason,created_at')
    .eq('account_id', accountId).eq('connection_id', connectionId)
    .eq('allowed', false)
    .gte('created_at', new Date(Date.now() - 24 * 3600_000).toISOString())
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  checkDb(denialError, 'last-admission-denial')
  let approvedMessagesPerRecipient = 1
  if (cohortGrants > 0) {
    const { data: grantCapacity, error: capError } = await db.from('whatsapp_openwa_pilot_allowlist')
      .select('messages_per_recipient').eq('account_id', accountId)
      .eq('connection_id', connectionId).eq('active', true)
      .in('workload', ['manual', 'agent'])
      .gt('expires_at', new Date().toISOString()).limit(MAX_BATCH_CONTACTS + 1)
    checkDb(capError, 'grant-capacity')
    const perContact = (grantCapacity ?? []).map(row => Number(row.messages_per_recipient))
    if (perContact.length !== cohortGrants ||
        perContact.some(value => !Number.isInteger(value) ||
          value < 1 || value > OPENWA_TEST_PILOT_MAX_MESSAGES_PER_RECIPIENT ||
          value !== perContact[0])) {
      throw new WhatsAppTransportError('connection_restricted', 'Pilot cohort capacity changed; review grants')
    }
    approvedMessagesPerRecipient = perContact[0]
  }
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
  return { connection, guard: safeGuard, configured, grants: grants ?? 0,
    manualGrants: manualGrants ?? 0, agentGrants: agentGrants ?? 0, apiGrants: apiGrants ?? 0, cohortGrants,
    pending: pending ?? 0, duplicates, enforced, approvedMessagesPerRecipient,
    lastDenial: lastDenial && ['not_allowlisted','invalid_identity','connection_scope_mismatch','invalid_request'].includes(lastDenial.reason)
      ? { workload: lastDenial.workload, reason: lastDenial.reason, created_at: lastDenial.created_at }
      : lastDenial ? { workload: lastDenial.workload, reason: 'policy', created_at: lastDenial.created_at } : null,
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
      pilot_agent_hourly_cap: s.guard.pilot_agent_hourly_cap,
      pilot_agent_daily_cap: s.guard.pilot_agent_daily_cap,
      pilot_manual_hourly_cap: s.guard.pilot_manual_hourly_cap,
      pilot_manual_daily_cap: s.guard.pilot_manual_daily_cap,
    },
    active_admissions: s.grants,
    approved_messages_per_recipient: s.cohortGrants > 0 ? s.approvedMessagesPerRecipient : null,
    required_cohort_messages: s.cohortGrants * s.approvedMessagesPerRecipient,
    agent_admissions: s.agentGrants,
    manual_admissions: s.manualGrants,
    api_admissions: s.apiGrants,
    approved_workload: s.grants > 0
      ? (s.agentGrants === s.grants ? 'agent' : s.manualGrants === s.grants ? 'manual' : null)
      : null,
    unsettled_outbound: s.pending, same_identity_ready_connections: s.duplicates,
    last_denial: s.lastDenial }
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
    if (!['prepare', 'limits', 'grant', 'grant_agent', 'grant_batch', 'grant_admin_alert', 'activate', 'stop', 'disable', 'enable'].includes(String(action))) return deny('Unknown pilot action', 400)
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
          manual_paused: true, hourly_cap: DEFAULT_HOURLY, daily_cap: DEFAULT_DAILY,
          first_touch_daily_cap: DEFAULT_FIRST_TOUCH, minimum_interval_ms: MIN_INTERVAL,
          jitter_ms: 3000, warmup_until: new Date(Date.now() + 7 * 86400000).toISOString(),
          warmup_hourly_cap: DEFAULT_HOURLY, warmup_daily_cap: DEFAULT_DAILY,
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
          ...(!s.configured ? { hourly_cap: DEFAULT_HOURLY, daily_cap: DEFAULT_DAILY,
            first_touch_daily_cap: DEFAULT_FIRST_TOUCH, minimum_interval_ms: MIN_INTERVAL,
            jitter_ms: 3000, warmup_hourly_cap: DEFAULT_HOURLY, warmup_daily_cap: DEFAULT_DAILY } : {}),
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
      const agentHourly = int(body.pilot_agent_hourly_cap ?? hourly, 1, MAX_HOURLY, 'agent hourly')
      const agentDaily = int(body.pilot_agent_daily_cap ?? daily, 1, MAX_DAILY, 'agent daily')
      const manualHourly = int(body.pilot_manual_hourly_cap ?? hourly, 1, MAX_HOURLY, 'manual hourly')
      const manualDaily = int(body.pilot_manual_daily_cap ?? daily, 1, MAX_DAILY, 'manual daily')
      if (agentHourly > hourly || agentDaily > daily ||
          manualHourly > hourly || manualDaily > daily) {
        return deny('Workload limits must not exceed the shared session cap', 400)
      }
      if (s.grants > 0) return deny('Stop and clear pilot grants before editing workload caps', 409)
      const { data: updated, error } = await adminDb.from('whatsapp_connection_guardrails')
        .update({ hourly_cap: hourly, daily_cap: daily, first_touch_daily_cap: firstTouch,
          minimum_interval_ms: interval, jitter_ms: jitter,
          warmup_hourly_cap: hourly, warmup_daily_cap: daily,
          pilot_agent_hourly_cap: agentHourly, pilot_agent_daily_cap: agentDaily,
          pilot_manual_hourly_cap: manualHourly, pilot_manual_daily_cap: manualDaily,
          updated_at: new Date().toISOString() })
        .eq('account_id', accountId).eq('connection_id', connectionId)
        .eq('manual_paused', true).select('connection_id').maybeSingle()
      checkDb(error, 'limits')
      if (!updated) return deny('Pilot state changed; retry after refresh', 409)
      return NextResponse.json(safeStatus(await snapshot(adminDb, accountId, connectionId)), { headers: noStore })
    }

    if (action === 'grant_admin_alert') {
      // Explicit UI opt-in, scoped to a VERIFIED trusted administrator only.
      // This additive API grant does not revoke the already authorized
      // Agent cohort or trigger any outbound send.
      if (body.consent_confirmed !== true || body.confirm_admin_alerts !== true) {
        return deny('Explicit trusted-admin WhatsApp notification consent is required', 400)
      }
      const identityId = typeof body.identity_id === 'string' ? body.identity_id : ''
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identityId)) {
        return deny('Select an existing trusted administrator', 400)
      }
      if (!s.configured || !s.guard.pilot_enabled || !s.enforced ||
          !s.active || s.guard.manual_paused || s.pending !== 0 ||
          !s.connection.session_id || !['ready','connected'].includes(s.connection.status) ||
          (s.duplicates > 1 && body.ack_duplicate_sessions !== true)) {
        return deny('A ready, explicitly activated TEST Pilot and zero unsettled sends are required', 409)
      }
      const { data: adminIdentity, error: adminError } = await adminDb.from('trusted_admin_identities')
        .select('id,normalized_address,status,verified_at,allowed_capabilities')
        .eq('account_id', accountId).eq('id', identityId)
        .eq('channel', 'whatsapp').eq('status', 'active')
        .is('revoked_at', null).maybeSingle()
      checkDb(adminError, 'trusted-admin-alert-identity')
      if (!adminIdentity?.verified_at ||
          !Array.isArray(adminIdentity.allowed_capabilities) ||
          !adminIdentity.allowed_capabilities.includes('change_requests.approve')) {
        return deny('Trusted administrator is not verified or lacks approval capability', 409)
      }
      const resolved = await resolveOpenWAPilotRecipientForGrant(
        adminDb, accountId, connectionId, adminIdentity.normalized_address,
      )
      const hash = openWAPilotRecipientHash(accountId, connectionId, resolved.recipient)
      if (!hash) return deny('Trusted admin recipient could not be resolved', 409)
      const { data: already, error: alreadyError } = await adminDb
        .from('whatsapp_openwa_pilot_allowlist').select('id')
        .eq('account_id', accountId).eq('connection_id', connectionId)
        .eq('workload', 'api').eq('recipient_hash', hash)
        .eq('active', true).gt('expires_at', new Date().toISOString()).maybeSingle()
      checkDb(alreadyError, 'admin-alert-existing-grant')
      if (already) return NextResponse.json({
        ...safeStatus(await snapshot(adminDb, accountId, connectionId)),
        admin_alert_granted: true, already_granted: true,
      }, { headers: noStore })
      if (s.grants >= MAX_BATCH_CONTACTS) return deny('The TEST cohort has reached its explicit approval limit', 409)
      const now = new Date()
      const { error: grantError } = await adminDb.from('whatsapp_openwa_pilot_allowlist')
        .upsert({
          account_id: accountId, connection_id: connectionId,
          workload: 'api', recipient_hash: hash,
          active: true, approved_by: user.id,
          approved_at: now.toISOString(), expires_at: new Date(now.getTime() + 4 * 3600_000).toISOString(),
          consent_basis: 'trusted_admin_verified', consent_attested_at: now.toISOString(),
          messages_per_recipient: 1,
        }, { onConflict: 'account_id,connection_id,recipient_hash,workload' })
      checkDb(grantError, 'trusted-admin-api-grant')
      return NextResponse.json({
        ...safeStatus(await snapshot(adminDb, accountId, connectionId)),
        admin_alert_granted: true,
      }, { headers: noStore })
    }

    if (action === 'grant_batch') {
      const workload = body.workload
      if (workload !== 'agent' && workload !== 'manual') return deny('Invalid pilot workload', 400)
      const recipients = body.recipients
      if (!Array.isArray(recipients) || recipients.length < 1 ||
          recipients.length > MAX_BATCH_CONTACTS ||
          !recipients.every(x => typeof x === 'string' && canonicalOpenWAPilotRecipient(x))) {
        return deny('Provide 1–10 valid explicit recipients', 400)
      }
      const consentBasis = body.consent_basis === 'phone_call' ? 'phone_call' : 'verified_inbound'
      if (workload === 'agent' && body.consent_basis != null &&
          !['phone_call', 'verified_inbound'].includes(String(body.consent_basis))) {
        return deny('Invalid Agent consent basis', 400)
      }
      if (workload === 'agent' && consentBasis === 'phone_call' &&
          body.phone_call_opt_in_confirmed !== true) {
        return deny('Confirm each person explicitly agreed by telephone to receive WhatsApp messages', 400)
      }
      if (body.consent_confirmed !== true ||
          (workload === 'agent' && body.confirm_agent_task_test !== true)) {
        return deny('Explicit consent and Agent Task approval are required', 400)
      }
      if (!s.configured || !s.guard.pilot_enabled || !s.enforced ||
          !s.guard.manual_paused || s.grants !== 0 || s.pending !== 0 ||
          !s.connection.session_id || !['ready','connected'].includes(s.connection.status) ||
          (s.duplicates > 1 && body.ack_duplicate_sessions !== true)) {
        return deny('Pause and clear prior grants before approving a bounded cohort', 409)
      }
      requireLimits(s)
      const count = recipients.length
      const messagesPerRecipient = int(body.messages_per_recipient ??
        OPENWA_TEST_PILOT_DEFAULT_MESSAGES_PER_RECIPIENT, 1,
        OPENWA_TEST_PILOT_MAX_MESSAGES_PER_RECIPIENT, 'messages per recipient')
      if (count * messagesPerRecipient > MAX_HOURLY) {
        return deny('عدد الجهات × الرسائل لكل جهة يتجاوز سقف TEST الساعي (100). قلّل الرسائل لكل جهة أو حجم المجموعة.', 400, 'pilot_capacity_exceeds_max')
      }
      const requiredMessages = requiredPilotCohortMessages(count, messagesPerRecipient)
      const missingCaps = missingPilotCohortCaps(s.guard, count, workload, messagesPerRecipient)
      if (missingCaps.length > 0) {
        return NextResponse.json({
          error: `لا تكفي حدود Pilot لاعتماد ${count} جهات × ${messagesPerRecipient} رسائل لكل جهة = ${requiredMessages} رسالة. يجب أن تستوعب حدود الجلسة والإحماء ونوع الإرسال ${requiredMessages} رسالة، وحد أول تواصل ${count} جهات.`,
          code: 'pilot_cohort_caps_insufficient',
          required_count: count,
          messages_per_recipient: messagesPerRecipient,
          required_messages: requiredMessages,
          missing_caps: missingCaps,
        }, { status: 409, headers: noStore })
      }

      const resolved = await Promise.all(recipients.map(input =>
        resolveOpenWAPilotRecipientForGrant(adminDb, accountId, connectionId, input)))
      if (workload === 'agent' && consentBasis === 'phone_call' &&
          resolved.some(item => item.source === 'direct_recipient')) {
        return deny('Phone-call opt-in requires a real international phone number, not an unbound native chat ID', 400)
      }
      if (workload === 'agent' && consentBasis === 'verified_inbound') {
        // Inbound-based approval still verifies the exact recent native chat.
        // within the 24h reply window. Typed first-touch numbers are denied.
        for (const item of resolved) {
          if (item.source === 'phone_without_inbound') {
            return deny('لا توجد محادثة واردة موثقة. إذا حصلت على موافقة صريحة على رسائل واتساب عبر الهاتف، فعّل خيار الموافقة الهاتفية قبل اعتماد الوكيل.', 409)
          }
          const { data: inbound, error: inboundError } = await adminDb.from('messages')
            .select('conversation_id').eq('connection_id', connectionId)
            .eq('provider', 'openwa').eq('sender_type', 'customer')
            .eq('provider_chat_id', item.recipient)
            .gte('created_at', new Date(Date.now() - 24 * 3600_000).toISOString())
            .order('created_at', { ascending: false }).limit(1).maybeSingle()
          checkDb(inboundError, 'agent-batch-recent-inbound')
          if (!inbound?.conversation_id) return deny('لا توجد رسالة واتساب واردة خلال 24 ساعة. يمكنك بدلًا من ذلك اعتماد موافقة واتساب الصريحة التي حصلت عليها عبر مكالمة هاتفية.', 409)
          const { data: scoped, error: scopedError } = await adminDb.from('conversations')
            .select('id').eq('id', inbound.conversation_id)
            .eq('account_id', accountId).maybeSingle()
          checkDb(scopedError, 'agent-batch-account-scope')
          if (!scoped) return deny('A selected chat does not belong to the account', 409)
        }
      }
      const hashes = resolved.map(item =>
        openWAPilotRecipientHash(accountId, connectionId, item.recipient))
      if (hashes.some(hash => !hash) || new Set(hashes).size !== count) {
        return deny('Duplicate or unresolved recipient identities', 400)
      }
      const hours = int(body.hours ?? 4, 1, 4, 'expiry')
      const now = new Date()
      const { error } = await adminDb.from('whatsapp_openwa_pilot_allowlist').upsert(
        hashes.map(recipient_hash => ({
          account_id: accountId, connection_id: connectionId,
          recipient_hash, workload, active: true, approved_by: user.id,
          messages_per_recipient: messagesPerRecipient,
          consent_basis: workload === 'agent' ? consentBasis : 'verified_inbound',
          consent_attested_at: workload === 'agent' && consentBasis === 'phone_call' ? now.toISOString() : null,
          approved_at: now.toISOString(),
          expires_at: new Date(now.getTime() + hours * 3600000).toISOString(),
        })),
        { onConflict: 'account_id,connection_id,recipient_hash,workload' },
      )
      checkDb(error, 'batch-grant')
      return NextResponse.json({
        ...safeStatus(await snapshot(adminDb, accountId, connectionId)),
        approved_workload: workload, approved_count: count,
         required_messages: requiredMessages, messages_per_recipient: messagesPerRecipient,
      }, { headers: noStore })
    }

    if (action === 'grant' || action === 'grant_agent') {
      const workload = action === 'grant_agent' ? 'agent' : 'manual'
      const consentBasis = body.consent_basis === 'phone_call' ? 'phone_call' : 'verified_inbound'
      if (workload === 'agent' && body.consent_basis != null &&
          !['phone_call', 'verified_inbound'].includes(String(body.consent_basis))) {
        return deny('Invalid Agent consent basis', 400)
      }
      if (workload === 'agent' && consentBasis === 'phone_call' &&
          body.phone_call_opt_in_confirmed !== true) {
        return deny('Confirm explicit telephone opt-in to WhatsApp messages', 400)
      }
      if (workload === 'agent' && body.confirm_agent_task_test !== true) {
        return deny('Explicit Agent Task TEST approval is required', 400)
      }
      if (!s.configured || !s.guard.pilot_enabled || !s.enforced || !s.guard.manual_paused) return deny('Enable the server-side gate and pause before granting a recipient', 409)
      if (body.consent_confirmed !== true) return deny('Recipient consent is required', 400)
      if (s.duplicates > 1 && body.ack_duplicate_sessions !== true) return deny('Duplicate connection identity must be reviewed', 409)
      if (!s.connection.session_id || !['ready','connected'].includes(s.connection.status) || s.pending !== 0 || s.grants !== 0) {
        return deny('Pilot session is not ready, has unsettled sends or already has a grant', 409)
      }
      requireLimits(s)
      if (workload === 'agent' &&
          (s.guard.hourly_cap !== 1 || s.guard.daily_cap !== 1 || s.guard.first_touch_daily_cap > 1 ||
           s.guard.warmup_hourly_cap !== 1 || s.guard.warmup_daily_cap !== 1)) {
        return deny('Agent Task TEST requires one message per hour and per day', 409)
      }
      const rawRecipient = typeof body.recipient === 'string' ? body.recipient.trim() : ''
      if (!canonicalOpenWAPilotRecipient(rawRecipient)) return deny('Invalid OpenWA recipient identity', 400)
      // The inbound chat may have a verified @lid identity even when the
      // admin types its contact's phone number. Resolve the exact same
      // session-scoped chat that the send core will use, not a guessed @c.us.
      const resolvedRecipient = await resolveOpenWAPilotRecipientForGrant(
        adminDb, accountId, connectionId, rawRecipient,
      )
      if (workload === 'agent' && consentBasis === 'phone_call' &&
          resolvedRecipient.source === 'direct_recipient') {
        return deny('Phone-call opt-in requires a real international phone number, not an unbound native chat ID', 400)
      }
      if (workload === 'agent' && consentBasis === 'verified_inbound' && resolvedRecipient.source === 'phone_without_inbound') {
        return deny('اعتماد المحادثة الواردة يتطلب رسالة واتساب؛ استخدم خيار الموافقة الهاتفية إذا وافق صاحب الرقم صراحةً على تلقي رسائل واتساب.', 409)
      }
      if (workload === 'agent' && consentBasis === 'verified_inbound') {
        // The inbound-based approval route still requires its native session identity. The inbound
        // identity must match the exact OpenWA chat, connection and tenant.
        const { data: inbound, error: inboundError } = await adminDb.from('messages')
          .select('conversation_id')
          .eq('connection_id', connectionId).eq('provider', 'openwa')
          .eq('sender_type', 'customer')
          .eq('provider_chat_id', resolvedRecipient.recipient)
          .gte('created_at', new Date(Date.now() - 24 * 3600_000).toISOString())
          .order('created_at', { ascending: false }).limit(1).maybeSingle()
        checkDb(inboundError, 'agent-recent-inbound')
        if (!inbound?.conversation_id) {
          return deny('لم تُرصد رسالة واتساب واردة خلال 24 ساعة. اختر الموافقة الهاتفية إذا كان العميل قد وافق صراحةً على التواصل عبر واتساب.', 409)
        }
        const { data: scoped, error: scopedError } = await adminDb.from('conversations')
          .select('id').eq('id', inbound.conversation_id)
          .eq('account_id', accountId).maybeSingle()
        checkDb(scopedError, 'agent-inbound-scope')
        if (!scoped) return deny('Agent Task TEST conversation does not belong to this account', 409)
      }
      const hash = openWAPilotRecipientHash(accountId, connectionId, resolvedRecipient.recipient)
      if (!hash) return deny('Invalid recipient', 400)
      const hours = int(body.hours ?? 4, 1, 4, 'expiry')
      const now = new Date()
      const { error } = await adminDb.from('whatsapp_openwa_pilot_allowlist')
        .upsert({ account_id: accountId, connection_id: connectionId,
          recipient_hash: hash, workload, active: true, approved_by: user.id,
           messages_per_recipient: 1,
          consent_basis: workload === 'agent' ? consentBasis : 'verified_inbound',
          consent_attested_at: workload === 'agent' && consentBasis === 'phone_call' ? now.toISOString() : null,
          approved_at: now.toISOString(), expires_at: new Date(now.getTime() + hours * 3600000).toISOString() },
        { onConflict: 'account_id,connection_id,recipient_hash,workload' })
      checkDb(error, 'grant')
      return NextResponse.json({
        ...safeStatus(await snapshot(adminDb, accountId, connectionId)),
        recipient_identity_source: resolvedRecipient.source,
        approved_workload: workload,
      }, { headers: noStore })
    }

    if (action === 'activate') {
      if (!s.configured || !s.guard.pilot_enabled || !s.enforced || !s.guard.manual_paused ||
          s.grants < 1 || s.grants > MAX_BATCH_CONTACTS ||
          (s.manualGrants !== s.grants && s.agentGrants !== s.grants) || s.pending !== 0 ||
          !s.connection.session_id || !['ready','connected'].includes(s.connection.status)) {
        return deny('Pilot activation requires enforce mode, one approval, paused/ready connection and zero unsettled sends', 409)
      }
      if (s.duplicates > 1 && body.ack_duplicate_sessions !== true) return deny('Duplicate sessions need explicit review', 409)
      requireLimits(s)
      const grantWorkload = s.agentGrants === s.grants ? 'agent' : 'manual'
      if (missingPilotCohortCaps(s.guard, s.grants, grantWorkload,
            s.approvedMessagesPerRecipient).length > 0) {
        return deny('لا تكفي حدود الجلسة الحالية للعدد المعتمد × الرسائل لكل جهة. راجع حدود Pilot قبل التشغيل.', 409,
          'pilot_cohort_caps_insufficient')
      }
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
        latest.grants !== s.grants || latest.manualGrants !== s.manualGrants ||
        latest.agentGrants !== s.agentGrants || latest.pending !== 0) {
        return deny('Pilot state changed during verification; refresh and review', 409, 'pilot_state_changed')
      }
      requireLimits(latest)
      if (latest.approvedMessagesPerRecipient !== s.approvedMessagesPerRecipient ||
          missingPilotCohortCaps(latest.guard, latest.grants,
            grantWorkload, latest.approvedMessagesPerRecipient).length > 0) {
        return deny('Pilot cohort capacity changed while validating gateway', 409, 'pilot_state_changed')
      }
      const { data: updated, error } = await adminDb.from('whatsapp_connection_guardrails')
        .update({ manual_paused: false, updated_at: new Date().toISOString() })
        .eq('account_id', accountId).eq('connection_id', connectionId).eq('manual_paused', true)
        .select('connection_id').maybeSingle()
      checkDb(error, 'activate')
      if (!updated) return deny('Pilot state changed; refresh first', 409)
      const { error: auditError } = await adminDb.from('whatsapp_guardrail_events')
        .insert({ account_id: accountId, connection_id: connectionId, workload: grantWorkload,
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
