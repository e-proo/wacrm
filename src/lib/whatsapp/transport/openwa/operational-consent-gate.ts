import type { SupabaseClient } from '@supabase/supabase-js'

import { isOpenWATestProject } from './environment'
import { OpenWAPreDispatchDenied } from './pre-dispatch-denied'

/**
 * OW14-W07-04 outbound-only admission; Meta, inbound, ACK and reconciliation
 * MUST NOT call this module.
 *
 * Production and any non-TEST Supabase project require an explicit deployment
 * release gate PLUS current owner consent and same-event per-session activation.
 * The previously approved TEST-only Pilot is unchanged by default. To exercise
 * this gate safely in the pinned TEST environment set
 * WACRM_W07_TEST_GATE_MODE=enforce; this does not enable a production release.
 */
export type OpenWAOperationalGateMode = 'legacy_test' | 'enforce_test' | 'enforce_release'

export type OpenWAOperationalDenialReason =
  | 'operational_test_configuration_invalid'
  | 'operational_release_disabled'
  | 'operational_evidence_unavailable'
  | 'operational_policy_not_approved'
  | 'operational_consent_required'
  | 'operational_consent_outdated'
  | 'operational_activation_required'
  | 'operational_activation_suspended'
  | 'operational_consent_changed'
  | 'operational_connection_not_ready'
  | 'operational_connection_scope_mismatch'

function deny(reason: OpenWAOperationalDenialReason): never {
  // All possible messages are intentionally generic and contain no tenant,
  // phone, gateway, secret, session or recipient identifiers.
  throw new OpenWAPreDispatchDenied(
    'OpenWA operational approval does not permit this outbound send; review the current account policy and connection state.',
    reason,
  )
}

export function openWAOperationalGateMode(): OpenWAOperationalGateMode {
  if (isOpenWATestProject()) {
    const mode = process.env.WACRM_W07_TEST_GATE_MODE
    if (mode === undefined || mode === '' || mode === 'legacy') return 'legacy_test'
    if (mode === 'enforce') return 'enforce_test'
    return deny('operational_test_configuration_invalid')
  }
  // Unknown/invalid project URLs and non-TEST environments must NEVER
  // select the TEST legacy carve-out.
  return 'enforce_release'
}

/** No browser or admin can override a deployment release flag with a DB row.
 * Setting this flag does not override W07 consent, guardrails or Pilot. */
function assertReleaseGate(mode: OpenWAOperationalGateMode): void {
  if (mode === 'enforce_release' &&
      process.env.WACRM_OPENWA_PRODUCTION_RELEASE_ENABLED !== 'true') {
    deny('operational_release_disabled')
  }
}

type ApprovalRow = { version: string; digest: string }
type ConsentRow = {
  status: string
  policy_version: string
  policy_digest: string
  accepted_event_id: string | null
}
type ActivationRow = { status: string; consent_event_id: string | null }
type EventRow = { action: string; policy_version: string; policy_digest: string }
type ConnectionRow = { status: string; session_id: string | null }

/**
 * Server-side, account-scoped proof for ONE send. Must be called before
 * guardrail capacity reservation and again at the last adapter boundary.
 * Even successful return means only the W07 layer was passed, NOT that
 * recipient policy, cap, Pilot or emergency stop allows dispatch.
 */
export async function assertOpenWAOperationalSendAllowed(
  db: SupabaseClient,
  accountId: string,
  connectionId: string,
  expectedSessionId?: string,
): Promise<void> {
  const mode = openWAOperationalGateMode()
  if (mode === 'legacy_test') return
  assertReleaseGate(mode)

  if (!accountId || !connectionId) deny('operational_connection_scope_mismatch')

  // All data is read through server-only service_role after tenant identity
  // is already bound by the caller. No browser Data API grants exist.
  // Sequence: prevent unnecessary sensitive reads if no current policy exists.
  const { data: approved, error: policyError } = await db
    .from('whatsapp_openwa_policy_versions')
    .select('version,digest')
    .eq('is_current', true)
    .maybeSingle()
  if (policyError) deny('operational_evidence_unavailable')
  if (!approved || typeof approved.version !== 'string' ||
      !/^[a-f0-9]{64}$/.test(approved.digest)) deny('operational_policy_not_approved')
  const policy = approved as ApprovalRow

  const { data: consent, error: consentError } = await db
    .from('whatsapp_openwa_consent_state')
    .select('status,policy_version,policy_digest,accepted_event_id')
    .eq('account_id', accountId)
    .maybeSingle()
  if (consentError) deny('operational_evidence_unavailable')
  if (!consent || consent.status !== 'accepted' || !consent.accepted_event_id) {
    deny('operational_consent_required')
  }
  const accountConsent = consent as ConsentRow
  if (accountConsent.policy_version !== policy.version ||
      accountConsent.policy_digest !== policy.digest) deny('operational_consent_outdated')

  const { data: activation, error: activationError } = await db
    .from('whatsapp_openwa_activation_state')
    .select('status,consent_event_id')
    .eq('account_id', accountId)
    .eq('connection_id', connectionId)
    .maybeSingle()
  if (activationError) deny('operational_evidence_unavailable')
  if (!activation || activation.status === 'disabled') deny('operational_activation_required')
  if (activation.status === 'suspended') deny('operational_activation_suspended')
  if (activation.status !== 'enabled' ||
      activation.consent_event_id !== accountConsent.accepted_event_id) {
    deny('operational_consent_changed')
  }
  const requested = activation as ActivationRow
  if (!requested.consent_event_id) deny('operational_consent_changed')

  // Verify the accepted event actually belongs to the same account and
  // version; not merely a UUID present in an activation state row.
  const { data: event, error: eventError } = await db
    .from('whatsapp_openwa_consent_audit')
    .select('action,policy_version,policy_digest')
    .eq('account_id', accountId)
    .eq('id', accountConsent.accepted_event_id)
    .maybeSingle()
  if (eventError) deny('operational_evidence_unavailable')
  if (!event || (event as EventRow).action !== 'accept' ||
      (event as EventRow).policy_version !== policy.version ||
      (event as EventRow).policy_digest !== policy.digest) {
    deny('operational_consent_changed')
  }

  // Repeat the exact provider + tenant + live readiness check so a session
  // archived/disconnected during pacing cannot be dispatched by a stale
  // transport object. No QR, credentials or private metadata are returned.
  const { data: connection, error: connectionError } = await db
    .from('whatsapp_connections')
    .select('status,session_id')
    .eq('account_id', accountId)
    .eq('id', connectionId)
    .eq('provider', 'openwa')
    .is('archived_at', null)
    .maybeSingle()
  if (connectionError) deny('operational_evidence_unavailable')
  if (!connection) deny('operational_connection_scope_mismatch')
  const live = connection as ConnectionRow
  if (!['connected', 'ready'].includes(live.status) ||
      typeof live.session_id !== 'string' || live.session_id.length === 0 ||
      (expectedSessionId !== undefined && live.session_id !== expectedSessionId)) {
    deny('operational_connection_not_ready')
  }
}
