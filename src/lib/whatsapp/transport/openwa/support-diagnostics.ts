/**
 * W07-06 privacy-preserving operational support snapshot.
 *
 * Strict ALLOWLIST ONLY: never put any raw API payload, identifier, host,
 * phone, JID, message text, QR, credential, audit actor or error message
 * into a support report. The browser makes read-only calls via existing
 * authenticated WACRM API; this helper performs NO network operations.
 */
export type SupportSourceStatus = 'ok' | 'unauthorized' | 'forbidden' | 'unavailable' | 'invalid'
export type SupportSource = { status: SupportSourceStatus; data?: unknown }
export type SupportGateMode = 'legacy_test' | 'enforce_test' | 'enforce_release' | 'unknown'
export type SupportConsentStatus = 'accepted' | 'revoked' | 'missing' | 'unknown'
export type SupportReason =
  | 'policy_not_approved' | 'consent_required' | 'consent_outdated'
  | 'connection_disabled' | 'connection_suspended' | 'consent_changed'
  | 'session_not_ready' | 'deployment_release_disabled'
  | 'request_admission_required' | 'unknown'
export type SafeSupportSnapshot = {
  version: 'w07-support-v1'
  operationalRead: SupportSourceStatus
  sessionsRead: SupportSourceStatus
  gateMode: SupportGateMode
  policyApproved: boolean | null
  consentStatus: SupportConsentStatus
  consentCurrent: boolean | null
  releaseConfigured: boolean | null
  connectionCount: number | null
  readyCount: number | null
  enabledRequestedCount: number | null
  blockingReasonCounts: Record<SupportReason, number>
  pausedCount: number | null
  uncertainCount: number | null
  countsConsistent: boolean | null
  /** Hints only: NEVER automatic root-cause or send permission. */
  suggestedProcedures: string[]
}
const allowedReasons: readonly SupportReason[] = [
  'policy_not_approved', 'consent_required', 'consent_outdated',
  'connection_disabled', 'connection_suspended', 'consent_changed',
  'session_not_ready', 'deployment_release_disabled',
  'request_admission_required',
]
const emptyReasonCounts = (): Record<SupportReason, number> => ({
  policy_not_approved: 0, consent_required: 0, consent_outdated: 0,
  connection_disabled: 0, connection_suspended: 0, consent_changed: 0,
  session_not_ready: 0, deployment_release_disabled: 0,
  request_admission_required: 0, unknown: 0,
})
function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}
function list(value: unknown): Record<string, unknown>[] | null {
  return Array.isArray(value) && value.every(item => obj(item) !== null)
    ? value as Record<string, unknown>[] : null
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1000000
    ? value : null
}
function mode(v: unknown): SupportGateMode {
  return v === 'legacy_test' || v === 'enforce_test' || v === 'enforce_release' ? v : 'unknown'
}
function consent(v: unknown): SupportConsentStatus {
  return v === 'accepted' || v === 'revoked' || v === 'missing' ? v : 'unknown'
}
function reason(v: unknown): SupportReason {
  return typeof v === 'string' && allowedReasons.includes(v as SupportReason)
    ? v as SupportReason : 'unknown'
}

/** Fail visibly on malformed responses; never fabricate a clean/zero state. */
export function deriveOpenWASupportSnapshot(
  operational: SupportSource, sessions: SupportSource,
): SafeSupportSnapshot {
  const policyBody = operational.status === 'ok' ? obj(operational.data) : null
  const sessionBody = sessions.status === 'ok' ? obj(sessions.data) : null
  const policy = obj(policyBody?.policy)
  const consentRecord = obj(policyBody?.consent)
  const operationalConnections = list(policyBody?.connections)
  const transportConnections = list(sessionBody?.connections)
  const operationalValid = policyBody?.provider === 'openwa' &&
    policyBody.production_send_authorized === false &&
    policy !== null && typeof policy.approved === 'boolean' &&
    consentRecord !== null && typeof consentRecord.current === 'boolean' &&
    operationalConnections !== null
  const sessionValid = transportConnections !== null
  const operationalRead = operational.status === 'ok' && !operationalValid
    ? 'invalid' : operational.status
  const sessionsRead = sessions.status === 'ok' && !sessionValid
    ? 'invalid' : sessions.status
  const safeOperational = operationalRead === 'ok'
  const safeSessions = sessionsRead === 'ok'
  const allowedOps = safeOperational ? operationalConnections! : []
  const allowedSessions = safeSessions ? transportConnections! : []
  const blockingReasonCounts = emptyReasonCounts()
  for (const connection of allowedOps) blockingReasonCounts[reason(connection.reason)]++
  const pausedCount = safeSessions
    ? allowedSessions.filter(connection => obj(connection.guardrail)?.manual_paused === true).length : null
  let uncertainCount: number | null = safeSessions ? 0 : null
  for (const connection of allowedSessions) {
    const outbound = obj(connection.outbound_review)
    const c = count(outbound?.unreviewed_count)
    if (c === null || uncertainCount === null || uncertainCount + c > 1000000) {
      uncertainCount = null
      break
    }
    uncertainCount += c
  }
  const suggestedProcedures = new Set<string>()
  if (!safeOperational) suggestedProcedures.add('test-schema-unavailable')
  if (safeOperational) {
    if (policy?.approved !== true) suggestedProcedures.add('policy-not-approved')
    if (consentRecord?.current !== true) suggestedProcedures.add('consent-stale')
    if (blockingReasonCounts.session_not_ready > 0) suggestedProcedures.add('session-disconnected')
    if (blockingReasonCounts.consent_changed > 0) suggestedProcedures.add('consent-stale')
    if (blockingReasonCounts.deployment_release_disabled > 0) suggestedProcedures.add('policy-not-approved')
  }
  if (uncertainCount !== null && uncertainCount > 0) suggestedProcedures.add('ambiguous-outbound')
  if (!safeSessions) suggestedProcedures.add('session-disconnected')

  return {
    version: 'w07-support-v1',
    operationalRead, sessionsRead,
    gateMode: safeOperational ? mode(policyBody?.operational_gate) : 'unknown',
    policyApproved: safeOperational ? policy!.approved as boolean : null,
    consentStatus: safeOperational ? consent(consentRecord?.status) : 'unknown',
    consentCurrent: safeOperational ? consentRecord!.current as boolean : null,
    releaseConfigured: safeOperational && mode(policyBody?.operational_gate) === 'enforce_release'
      ? policyBody?.deployment_release_enabled === true : null,
    connectionCount: safeOperational ? allowedOps.length : null,
    readyCount: safeOperational ? allowedOps.filter(c => c.session_ready === true).length : null,
    enabledRequestedCount: safeOperational
      ? allowedOps.filter(c => c.requested_activation === 'enabled').length : null,
    blockingReasonCounts,
    pausedCount,
    uncertainCount,
    countsConsistent: safeOperational && safeSessions
      ? allowedOps.length === allowedSessions.length : null,
    suggestedProcedures: [...suggestedProcedures],
  }
}

/** Output is entirely derived from literal allowlisted enums/numbers. Never
 * interpolate any untrusted payload fields, request URL, JID, logs or IDs. */
export function formatOpenWASupportHandoff(
  snapshot: SafeSupportSnapshot,
  createdAt: Date,
  language: string,
): string {
  const ar = language.toLowerCase().startsWith('ar')
  const title = ar ? 'تقرير دعم W07 المنقح — للقراءة فقط' : 'W07 redacted support status — read-only'
  const safeTime = Number.isFinite(createdAt.getTime()) ? createdAt.toISOString() : 'unavailable'
  const digit = (value: number | null) => value === null ? 'unavailable' : String(count(value) ?? 'unavailable')
  const fmt = (v: boolean | null) => v === null ? 'unknown' : v ? 'true' : 'false'
  return [
    title,
    'schema=w07-support-v1',
    'checked_at=' + safeTime,
    'operational_read=' + snapshot.operationalRead,
    'sessions_read=' + snapshot.sessionsRead,
    'gate_mode=' + snapshot.gateMode,
    'policy_approved=' + fmt(snapshot.policyApproved),
    'consent_status=' + snapshot.consentStatus,
    'consent_current=' + fmt(snapshot.consentCurrent),
    'release_configured=' + fmt(snapshot.releaseConfigured),
    'connection_count=' + digit(snapshot.connectionCount),
    'ready_count=' + digit(snapshot.readyCount),
    'requested_enabled_count=' + digit(snapshot.enabledRequestedCount),
    'paused_count=' + digit(snapshot.pausedCount),
    'outbound_unreviewed_count=' + digit(snapshot.uncertainCount),
    'connection_counts_consistent=' + fmt(snapshot.countsConsistent),
    ...allowedReasons.concat('unknown').filter(key => snapshot.blockingReasonCounts[key] > 0)
      .map(key => 'reason_' + key + '=' + digit(snapshot.blockingReasonCounts[key])),
    'suggestions=' + snapshot.suggestedProcedures
      .filter(id => /^[a-z0-9-]{1,64}$/.test(id)).slice(0,12).join(','),
    'note=' + (ar
      ? 'لا يحتوي هذا التقرير معرفات أو أسرارًا أو أرقامًا أو محتوى الرسائل. لا يثبت إذن الإرسال أو التسليم.'
      : 'No identifiers, credentials, phone numbers or message bodies. Not proof of sending authorization or delivery.'),
  ].join('\n')
}
