import { NextResponse } from 'next/server'

import { ForbiddenError, UnauthorizedError, requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { openWAOperationalGateMode } from '@/lib/whatsapp/transport/openwa/operational-consent-gate'
import {
  OPENWA_CONTROL_NO_STORE, canWriteOpenWAControl,
  isOpenWAControlSameOrigin, mapOpenWAControlOutcome,
  parseOpenWAPolicyMutation, readOpenWAControlJson,
} from '@/lib/whatsapp/transport/openwa/operational-control-api'

export const runtime = 'nodejs'
const noStore = OPENWA_CONTROL_NO_STORE

function reply(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: noStore })
}

function errorResponse(error: unknown) {
  if (error instanceof UnauthorizedError) return reply({ code: 'unauthorized', error: 'Authentication required' }, 401)
  if (error instanceof ForbiddenError) return reply({ code: 'forbidden', error: 'Account owner or admin permission required' }, 403)
  // Fail closed; Supabase errors can contain private identifiers/SQL details.
  return reply({ code: 'control_unavailable', error: 'OpenWA policy control is unavailable' }, 503)
}


/** Admin-scoped, read-only summary; never claims that W07-04 outbound gate
 * is installed. The public client cannot SELECT the new tables directly.
 * Session IDs are checked for readiness but never returned. */
export async function GET() {
  try {
    const { accountId, role, supabase } = await requireRole('admin')
    const db = supabaseAdmin()
    const [policy, consent, activation, connections, consentEvents, activationEvents] = await Promise.all([
      db.from('whatsapp_openwa_policy_versions')
        .select('version,digest,approved_at').eq('is_current', true).maybeSingle(),
      db.from('whatsapp_openwa_consent_state')
        .select('status,policy_version,policy_digest,accepted_event_id,revision,updated_at')
        .eq('account_id', accountId).maybeSingle(),
      db.from('whatsapp_openwa_activation_state')
        .select('connection_id,status,consent_event_id,revision,updated_at')
        .eq('account_id', accountId),
      supabase.from('whatsapp_connections')
        .select('id,display_name,status,session_id').eq('account_id', accountId)
        .eq('provider', 'openwa').is('archived_at', null)
        .order('created_at', { ascending: false }),
      db.from('whatsapp_openwa_consent_audit')
        .select('actor_id,action,policy_version,revision,recorded_at')
        .eq('account_id', accountId).order('recorded_at', { ascending: false }).limit(20),
      db.from('whatsapp_openwa_activation_audit')
        .select('connection_id,actor_id,previous_status,new_status,revision,recorded_at')
        .eq('account_id', accountId).order('recorded_at', { ascending: false }).limit(20),
    ])
    if (policy.error || consent.error || activation.error || connections.error ||
        consentEvents.error || activationEvents.error ||
        !Array.isArray(activation.data) || !Array.isArray(connections.data) ||
        !Array.isArray(consentEvents.data) || !Array.isArray(activationEvents.data)) {
      return reply({ code: 'control_unavailable', error: 'OpenWA policy state cannot be verified' }, 503)
    }
    // The W07-04 pre-dispatch gate is now installed. This is a configuration
    // summary only: no admin GET can promise a recipient-specific send.
    const gateMode = openWAOperationalGateMode()
    const releaseEnabled = gateMode !== 'enforce_release' ||
      process.env.WACRM_OPENWA_PRODUCTION_RELEASE_ENABLED === 'true'
    const current = policy.data
    const accepted = consent.data?.status === 'accepted'
    const policyCurrent = Boolean(current && accepted &&
      consent.data?.policy_version === current.version &&
      consent.data?.policy_digest === current.digest)
    const activeByConnection = new Map(activation.data.map((row) => [row.connection_id, row] as const))
    const list = connections.data.map((connection) => {
      const requested = activeByConnection.get(connection.id)
      const matchingAcceptance = Boolean(policyCurrent && requested?.status === 'enabled' &&
        consent.data?.accepted_event_id &&
        requested.consent_event_id === consent.data.accepted_event_id)
      const ready = ['ready', 'connected'].includes(connection.status) && Boolean(connection.session_id)
      const reason = !current ? 'policy_not_approved'
        : !accepted ? 'consent_required'
        : !policyCurrent ? 'consent_outdated'
        : !requested || requested.status === 'disabled' ? 'connection_disabled'
        : requested.status === 'suspended' ? 'connection_suspended'
        : !matchingAcceptance ? 'consent_changed'
        : !ready ? 'session_not_ready'
        : !releaseEnabled ? 'deployment_release_disabled'
        : 'request_admission_required'
      return {
        connection_id: connection.id,
        display_name: connection.display_name || 'OpenWA',
        session_status: connection.status,
        session_ready: ready,
        requested_activation: requested?.status ?? 'disabled',
        activation_revision: requested?.revision ?? 0,
        activation_updated_at: requested?.updated_at ?? null,
        reason,
        // W07-04 is active at dispatch; this summary cannot evaluate a
        // specific recipient/workload, so it never grants send permission.
        send_authorized: false,
      }
    })
    return reply({
      provider: 'openwa',
      meta_remains_default: true,
      operational_gate: gateMode,
      deployment_release_enabled: gateMode === 'enforce_release' && releaseEnabled,
      // This read-only summary is NOT the recipient/workload-specific send gate.
      production_send_authorized: false,
      mutation_stage: {
        owner_accept_available: role === 'owner' && canWriteOpenWAControl('accept'),
        connection_enable_available: canWriteOpenWAControl('enable'),
      },
      policy: current
        ? { approved: true, version: current.version, digest: current.digest }
        : { approved: false, version: null, digest: null },
      consent: {
        status: consent.data?.status ?? 'missing',
        current: policyCurrent,
        policy_version: consent.data?.policy_version ?? null,
        revision: consent.data?.revision ?? 0,
        updated_at: consent.data?.updated_at ?? null,
      },
      connections: list,
      audit: {
        consent: consentEvents.data,
        activation: activationEvents.data.filter((event) =>
          list.some((connection) => connection.connection_id === event.connection_id)),
        truncated_to: 20,
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}

/** Only the authenticated account OWNER may accept/revoke. The browser
 * cannot supply account_id/actor_id; they are derived after getUser().
 * Accept remains gated off by default until W07-04 ships and Legal signs.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('owner')
    if (!isOpenWAControlSameOrigin(request)) {
      return reply({ code: 'invalid_origin', error: 'Same-origin JSON request required' }, 403)
    }
    const parsed = parseOpenWAPolicyMutation(await readOpenWAControlJson(request))
    if (!parsed.ok) return reply({ code: parsed.code, error: 'Invalid policy action' }, 400)
    const body = parsed.value
    if (!canWriteOpenWAControl(body.action)) {
      return reply({ code: 'control_stage_not_ready', error: 'Policy acceptance is not available yet' }, 409)
    }
    const { data, error } = await supabaseAdmin().rpc('set_openwa_operational_consent', {
      p_account_id: accountId,
      p_actor: userId,
      p_action: body.action,
      p_policy_version: body.action === 'accept' ? body.policy_version : null,
      p_policy_digest: body.action === 'accept' ? body.policy_digest : null,
      p_expected_revision: body.expected_revision,
      p_request_id: body.request_id,
    })
    if (error) return reply({ code: 'control_unavailable', error: 'Policy update could not be verified' }, 503)
    const mapped = mapOpenWAControlOutcome(data)
    return reply(mapped.body, mapped.status)
  } catch (error) {
    return errorResponse(error)
  }
}
