import { createHash } from 'node:crypto'
import { OpenWAPreDispatchDenied } from './openwa/pre-dispatch-denied'
import { isOpenWATestProject } from './openwa/environment'
import { assertOpenWAOperationalSendAllowed, openWAOperationalGateMode } from './openwa/operational-consent-gate'
export { OpenWAPreDispatchDenied } from './openwa/pre-dispatch-denied'
export { isOpenWATestProject } from './openwa/environment'
import type { SupabaseClient } from '@supabase/supabase-js'
import { WhatsAppTransportError, type WhatsAppTransport, type WhatsAppTransportSendRequest, type WhatsAppTransportSendResult } from './types'

/**
 * A WACRM policy denial before any OpenWA provider dispatch. Unlike a
 * generic upstream error, this safely establishes the provider was not called
 * for this invocation. Automation may finalize its reserved local 'sending'
 * identity as failed without risking an ambiguous provider outcome.
 */

interface Reservation { allowed?: boolean; reason?: string; wait_ms?: number }
interface Admission { allowed?: boolean; reason?: string }
interface GuardrailFence { manual_paused: boolean; circuit_open_until: string | null }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const recipientHash = (accountId: string, connectionId: string, recipient: string) =>
  createHash('sha256').update(`${accountId}:${connectionId}:${recipient}`).digest('hex')

/**
 * Pilot admission uses one canonical provider-native identity. Never convert
 * a verified @lid chat into a phone number or treat alternate JID spellings
 * as separate allowlist entries.
 */
export function canonicalOpenWAPilotRecipient(value: string): string | null {
  if (/^[1-9][0-9]{6,14}$/.test(value)) return `${value}@c.us`
  if (/^[0-9]{5,20}@(c\.us|lid)$/.test(value)) return value
  return null
}

/** Opaque, scoped admission identity; no phone number/JID enters the pilot ledger. */
export function openWAPilotRecipientHash(accountId: string, connectionId: string, recipient: string): string | null {
  const canonical = canonicalOpenWAPilotRecipient(recipient)
  if (!canonical) return null
  return createHash('sha256').update(`openwa-pilot:v1:${accountId}:${connectionId}:${canonical}`).digest('hex')
}

/**
 * Development TEST environment is explicitly pinned to the authorized Supabase
 * project. URL parsing is strict, never a substring/contains test (e.g. a
 * malicious *.supabase.co.example.com host must not match).
 *
 * Only TEST gets always-on allowlist enforcement, so operators can manage the
 * actual single-session Start/Stop/recipient approvals through WACRM Settings
 * without editing .env.local. Production and other environments preserve their
 * existing OPENWA_PILOT_MODE behavior.
 */

export function openWAPilotEnforcementEnabled(
  mode = process.env.OPENWA_PILOT_MODE,
  projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
): boolean {
  if (mode !== undefined && mode !== '' && mode !== 'off' && mode !== 'enforce') {
    throw new WhatsAppTransportError('authentication_or_configuration', 'Invalid OpenWA pilot enforcement configuration')
  }
  // TEST is always protected, even if .env.local still says off.
  // NEVER permit a UI action to turn off the admission check.
  return mode === 'enforce' || isOpenWATestProject(projectUrl)
}

export class GuardedOpenWATransport implements WhatsAppTransport {
  readonly provider = 'openwa' as const
  constructor(private readonly db: SupabaseClient, private readonly inner: WhatsAppTransport) {}

  /**
   * TEST admins can disable Pilot for exactly one account-scoped connection.
   * Missing guardrail rows are protected; DB errors fail closed.
   * Non-TEST deployment flags are unchanged.
   */
  private async pilotEnforcedFor(request: WhatsAppTransportSendRequest): Promise<boolean> {
    const deploymentEnforced = openWAPilotEnforcementEnabled()
    if (!isOpenWATestProject()) return deploymentEnforced
    const { data, error } = await this.db.from('whatsapp_connection_guardrails')
      .select('pilot_enabled').eq('account_id', request.accountId)
      .eq('connection_id', request.connectionId).maybeSingle()
    if (error) throw new WhatsAppTransportError('retryable_provider_failure', 'OpenWA pilot mode could not be verified', error)
    return data?.pilot_enabled !== false
  }

  async send(request: WhatsAppTransportSendRequest): Promise<WhatsAppTransportSendResult> {
    // W07-04: current consent and exact connection activation are checked
    // before any guardrail reservation, for every outbound workload.
    await assertOpenWAOperationalSendAllowed(this.db, request.accountId, request.connectionId)
    const workload = request.workload ?? 'manual'
    const hash = recipientHash(request.accountId, request.connectionId, request.recipient)
    const pilotEnforced = await this.pilotEnforcedFor(request)

    // Do not consume guardrail capacity or call the gateway for an unauthorized
    // cohort. The RPC joins both tenant and connection with the allowlist.
    if (pilotEnforced) await this.assertPilotAdmission(request, workload)

    const { data, error } = await this.db.rpc(isOpenWATestProject() && pilotEnforced
      ? 'reserve_openwa_pilot_workload_send'
      : 'reserve_openwa_guardrail_send', {
      p_account_id: request.accountId,
      p_connection_id: request.connectionId,
      p_recipient_hash: hash,
      p_workload: workload,
    })
    if (error) throw new WhatsAppTransportError('retryable_provider_failure', 'Could not reserve OpenWA guardrail capacity', error)
    const reservation = (data ?? {}) as Reservation
    if (!reservation.allowed) throw new OpenWAPreDispatchDenied(`OpenWA send blocked by WACRM guardrail: ${reservation.reason ?? 'policy'}`)
    const waitMs = Math.max(0, Math.min(Number(reservation.wait_ms ?? 0), 600_000))
    if (waitMs > 0) await sleep(waitMs)

    // A pause or allowlist revocation during pacing must be observed before
    // provider dispatch. A POST already in flight cannot be retroactively
    // cancelled; ambiguous outcomes still require reconciliation.
    // For production (or explicitly gated TEST), always recheck emergency
    // stop at the last guarded boundary even if pacing wait was zero.
    if (pilotEnforced || waitMs > 0 || isOpenWATestProject() ||
        openWAOperationalGateMode() !== 'legacy_test') {
      await this.assertNotPaused(request)
      // If TEST mode was changed during pacing/reservation, do not dispatch
      // under the old admission assumption.
      if (isOpenWATestProject() && (await this.pilotEnforcedFor(request)) !== pilotEnforced) {
        throw new OpenWAPreDispatchDenied('OpenWA Pilot mode changed before dispatch; retry after refresh')
      }
      if (pilotEnforced && waitMs > 0) await this.assertPilotAdmission(request, workload)
    }

    try {
      const result = await this.inner.send(request)
      await this.record(request, hash, true)
      return result
    } catch (error) {
      // A W07 refusal is proven local; do not log it as a provider failure
      // or mistake it for an ambiguous OpenWA response requiring a resend.
      if (error instanceof OpenWAPreDispatchDenied) throw error
      await this.record(request, hash, false, error instanceof WhatsAppTransportError ? error.code : 'provider_failure')
      throw error
    }
  }

  private async assertPilotAdmission(request: WhatsAppTransportSendRequest, workload: string): Promise<void> {
    const hash = openWAPilotRecipientHash(request.accountId, request.connectionId, request.recipient)
    if (!hash) throw new OpenWAPreDispatchDenied('OpenWA pilot recipient identity is not permitted')
    const { data, error } = await this.db.rpc('check_openwa_pilot_admission', {
      p_account_id: request.accountId,
      p_connection_id: request.connectionId,
      p_recipient_hash: hash,
      p_workload: workload,
    })
    if (error) throw new WhatsAppTransportError('retryable_provider_failure', 'OpenWA pilot admission could not be verified', error)
    if (!(data as Admission | null)?.allowed) {
      const reason = (data as Admission | null)?.reason
      if (reason === 'not_allowlisted') {
        const nativeHint = request.recipient.endsWith('@lid')
          ? ' هوية المحادثة الواردة من نوع @lid وقد تختلف عن اعتماد الرقم الهاتفي.'
          : ''
        throw new OpenWAPreDispatchDenied(
          `رفض Pilot الإرسال: مستلم هذه المحادثة غير معتمد لنوع الإرسال ${workload} على جلسة OpenWA الحالية.${nativeHint} راجع الجهات المعتمدة لهذه الجلسة، وأعِد اعتماد المستلم الصحيح بموافقته الصريحة. لم تُرسل الرسالة إلى OpenWA.`,
          'pilot_recipient_not_allowlisted',
        )
      }
      if (reason === 'connection_scope_mismatch') {
        throw new OpenWAPreDispatchDenied(
          'رفض Pilot الإرسال: جلسة OpenWA المحددة غير جاهزة أو لا تطابق الحساب. تحقق من الجلسة والربط قبل المحاولة.',
          'pilot_connection_scope_mismatch',
        )
      }
      if (reason === 'invalid_identity') {
        throw new OpenWAPreDispatchDenied(
          'رفض Pilot الإرسال: تعذّر التحقق من هوية المستلم الأصلية. لا يمكن الاعتماد على رقم مشتق من @lid.',
          'pilot_recipient_identity_invalid',
        )
      }
      throw new OpenWAPreDispatchDenied(
        'رفض Pilot الإرسال بسبب عدم اجتياز فحص الاعتماد. افحص جلسة TEST والجهات المعتمدة، ولم تُرسل الرسالة.',
        'pilot_admission_denied',
      )
    }
  }

  private async assertNotPaused(request: WhatsAppTransportSendRequest): Promise<void> {
    const { data, error } = await this.db.from('whatsapp_connection_guardrails')
      .select('manual_paused, circuit_open_until')
      .eq('account_id', request.accountId)
      .eq('connection_id', request.connectionId)
      .maybeSingle()
    if (error || !data) throw new WhatsAppTransportError('retryable_provider_failure', 'OpenWA emergency stop state could not be verified', error)
    const fence = data as GuardrailFence
    if (fence.manual_paused !== false) throw new OpenWAPreDispatchDenied('OpenWA connection is paused')
    if (fence.circuit_open_until !== null) {
      const until = Date.parse(fence.circuit_open_until)
      if (!Number.isFinite(until) || until > Date.now()) {
        throw new OpenWAPreDispatchDenied('OpenWA circuit breaker is open')
      }
    }
  }

  private async record(request: WhatsAppTransportSendRequest, hash: string, success: boolean, reason?: string) {
    // This audit is post-dispatch best-effort. A network exception here must
    // NEVER turn a provider-accepted send into an apparent transport failure
    // (and thereby tempt a duplicate retry), or mask the provider's original
    // ambiguous/failure result. The guardrail *reservation* above stays
    // mandatory and fail-closed BEFORE dispatch.
    try {
      const { error } = await this.db.rpc('record_openwa_guardrail_outcome', {
        p_account_id: request.accountId,
        p_connection_id: request.connectionId,
        p_recipient_hash: hash,
        p_workload: request.workload ?? 'manual',
        p_success: success,
        p_reason: reason ?? null,
      })
      if (error) console.error('[openwa-guardrail] post-dispatch audit unavailable')
    } catch {
      // No raw error, connection ID, key, recipient, JID or provider result in logs.
      console.error('[openwa-guardrail] post-dispatch audit unavailable')
    }
  }
}
