import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { approveChangeRequestFromTrustedAdmin } from '@/lib/ai/runtime/change-requests-service'
import { executeApprovedChangeRequest } from '@/lib/ai/runtime/change-request-executor'
import { deliverActiveSubjectBusinessEventNotifications } from '@/lib/ai/runtime/customer-notification-delivery'
import { recordIntent } from '@/lib/services/intents/intents-service'
import { inspectCoverageBusinessEventCutoverReadiness } from './cutover'

const enabled =
  process.env.WACRM_COVERAGE_CUTOVER_TRANSPORT_E2E_LIVE === '1'
const liveDescribe = enabled ? describe : describe.skip

let accountIdForCleanup: string | null = null
let coverageRequestIdForCleanup: string | null = null
let previousRecoveryWorker: boolean | null = null

liveDescribe('Coverage active WhatsApp transport E2E on TEST', () => {
  afterEach(async () => {
    if (!accountIdForCleanup) return

    const db = supabaseAdmin()

    if (coverageRequestIdForCleanup) {
      await db
        .from('coverage_requests')
        .update({ status: 'cancelled' })
        .eq('account_id', accountIdForCleanup)
        .eq('id', coverageRequestIdForCleanup)
        .eq('status', 'active')
    }

    if (previousRecoveryWorker != null) {
      await db
        .from('ai_runtime_policies')
        .update({ recovery_worker_enabled: previousRecoveryWorker })
        .eq('account_id', accountIdForCleanup)
    }
  })

  it('sends one current canonical Coverage event and remains idempotent on replay', async () => {
    if (
      process.env.WACRM_COVERAGE_CUTOVER_TRANSPORT_E2E_CONFIRM !==
      'SEND_TEST_WHATSAPP'
    ) {
      throw new Error(
        'WACRM_COVERAGE_CUTOVER_TRANSPORT_E2E_CONFIRMATION_REQUIRED',
      )
    }

    const accountId =
      process.env.WACRM_COVERAGE_CUTOVER_LIVE_ACCOUNT_ID?.trim()
    const contactId =
      process.env.WACRM_COVERAGE_CUTOVER_TEST_CONTACT_ID?.trim()
    const conversationId =
      process.env.WACRM_COVERAGE_CUTOVER_TEST_CONVERSATION_ID?.trim()

    if (!accountId || !contactId || !conversationId) {
      throw new Error('WACRM_COVERAGE_CUTOVER_TEST_RECIPIENT_IDS_REQUIRED')
    }
    if (
      !process.env.NEXT_PUBLIC_SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY
    ) {
      throw new Error('SUPABASE_TEST_ENV_REQUIRED')
    }

    accountIdForCleanup = accountId
    const db = supabaseAdmin()

    const readiness = await inspectCoverageBusinessEventCutoverReadiness({
      accountId,
    })
    expect(readiness.mode).toBe('active')
    expect(readiness.ready).toBe(true)
    expect(readiness.activeNonterminal).toBe(0)
    expect(readiness.legacyNonterminal).toBe(0)

    const { data: deliveryControl, error: deliveryControlError } = await db
      .from('business_event_delivery_controls')
      .select('legacy_notification_write_enabled')
      .eq('account_id', accountId)
      .eq('route_key', 'coverage_customer_whatsapp')
      .maybeSingle()
    if (deliveryControlError) throw deliveryControlError
    if (!deliveryControl) {
      throw new Error('COVERAGE_CUTOVER_DELIVERY_CONTROL_REQUIRED')
    }
    expect(deliveryControl.legacy_notification_write_enabled).toBe(false)

    const { data: recipient, error: recipientError } = await db
      .from('conversations')
      .select('id, contact_id, account_id')
      .eq('account_id', accountId)
      .eq('id', conversationId)
      .eq('contact_id', contactId)
      .maybeSingle()
    if (recipientError) throw recipientError
    if (!recipient) {
      throw new Error('WACRM_COVERAGE_CUTOVER_TEST_RECIPIENT_NOT_FOUND')
    }

    const { data: account, error: accountError } = await db
      .from('accounts')
      .select('owner_user_id')
      .eq('id', accountId)
      .maybeSingle()
    if (accountError) throw accountError
    if (!account?.owner_user_id) {
      throw new Error('COVERAGE_CUTOVER_TEST_ACCOUNT_OWNER_REQUIRED')
    }
    const actorUserId = account.owner_user_id as string

    const { data: trustedAdminRows, error: trustedAdminError } = await db
      .from('trusted_admin_identities')
      .select('id, allowed_capabilities')
      .eq('account_id', accountId)
      .eq('channel', 'whatsapp')
      .eq('status', 'active')
    if (trustedAdminError) throw trustedAdminError

    const approvalIdentity = (trustedAdminRows ?? []).find(
      (row) =>
        Array.isArray(row.allowed_capabilities) &&
        row.allowed_capabilities.includes('change_requests.approve'),
    )
    if (!approvalIdentity?.id) {
      throw new Error('COVERAGE_CUTOVER_TRUSTED_APPROVER_REQUIRED')
    }

    const { data: policy, error: policyError } = await db
      .from('ai_runtime_policies')
      .select('recovery_worker_enabled')
      .eq('account_id', accountId)
      .maybeSingle()
    if (policyError) throw policyError
    if (!policy) throw new Error('COVERAGE_CUTOVER_RUNTIME_POLICY_REQUIRED')
    previousRecoveryWorker = policy.recovery_worker_enabled === true

    const { error: pauseError } = await db
      .from('ai_runtime_policies')
      .update({ recovery_worker_enabled: false })
      .eq('account_id', accountId)
    if (pauseError) throw pauseError

    const { data: service, error: serviceError } = await db
      .from('services')
      .select('id')
      .eq('account_id', accountId)
      .eq('code', 'coverage')
      .eq('status', 'active')
      .maybeSingle()
    if (serviceError) throw serviceError
    if (!service?.id) throw new Error('COVERAGE_CUTOVER_ACTIVE_SERVICE_REQUIRED')

    const { data: northRegion, error: northError } = await db
      .from('coverage_regions')
      .select('id')
      .eq('account_id', accountId)
      .eq('macro_region', 'north')
      .eq('status', 'active')
      .limit(1)
      .maybeSingle()
    if (northError) throw northError

    const { data: southRegion, error: southError } = await db
      .from('coverage_regions')
      .select('id')
      .eq('account_id', accountId)
      .eq('macro_region', 'south')
      .eq('status', 'active')
      .limit(1)
      .maybeSingle()
    if (southError) throw southError
    if (!northRegion?.id || !southRegion?.id) {
      throw new Error('COVERAGE_CUTOVER_ACTIVE_REGIONS_REQUIRED')
    }

    const fixtureKey = randomUUID()
    const recorded = await recordIntent({
      accountId,
      contactId,
      conversationId,
      direction: 'request',
      serviceHint: `coverage:${service.id}`,
      summary: 'Service Platform V2 active Coverage transport E2E fixture.',
      attributes: {
        test_fixture: true,
        purpose: 'service_platform_v2_coverage_active_transport',
      },
      escalateToAdmin: false,
      actorUserId,
    })

    const { data: createdRows, error: createError } = await db.rpc(
      'create_change_request_v3',
      {
        p_account_id: accountId,
        p_action_key: 'coverage.request.create',
        p_action_version: 1,
        p_target_type: 'coverage_request',
        p_target_id: null,
        p_intent: 'create',
        p_proposed_payload: {
          contact_id: contactId,
          conversation_id: conversationId,
          intent_id: recorded.intentId,
          service_id: service.id,
          requested_amount: '1000',
          currency: 'SAR',
          attributes: {
            coverage_scope: 'domestic',
            pay_region_id: northRegion.id,
            pay_method: 'cash',
            receive_region_id: southRegion.id,
            receive_method: 'cash',
          },
          test_fixture: true,
          fixture_key: fixtureKey,
        },
        p_expected_version: null,
        p_idempotency_key:
          `coverage-cutover-active-transport:${recorded.intentId}`,
        p_summary: '[TEST] Coverage active transport E2E',
        p_actor_user_id: actorUserId,
      },
    )
    if (createError) throw createError

    const created = (
      createdRows as Array<{
        id: string
        code: number
        confirmation_code: string | null
      }> | null
    )?.[0]
    if (!created?.id || !created.code || !created.confirmation_code) {
      throw new Error('COVERAGE_CUTOVER_CHANGE_REQUEST_CREATE_FAILED')
    }

    await approveChangeRequestFromTrustedAdmin({
      accountId,
      requestCode: created.code,
      confirmationCode: created.confirmation_code,
      identityId: approvalIdentity.id,
      inboundMessageId: null,
    })

    await executeApprovedChangeRequest({
      accountId,
      changeRequestId: created.id,
      actorUserId,
    })

    const { data: coverageRequest, error: requestError } = await db
      .from('coverage_requests')
      .select('id, status, source_change_request_id')
      .eq('account_id', accountId)
      .eq('source_change_request_id', created.id)
      .maybeSingle()
    if (requestError) throw requestError
    if (!coverageRequest?.id) {
      throw new Error('COVERAGE_CUTOVER_REQUEST_EXECUTION_MISSING')
    }
    coverageRequestIdForCleanup = coverageRequest.id

    const { data: eventBeforeSend, error: eventReadError } = await db
      .from('business_event_outbox')
      .select(
        'id, delivery_mode, status, legacy_notification_id, local_message_id, sent_at',
      )
      .eq('account_id', accountId)
      .eq('subject_type', 'coverage_request')
      .eq('subject_id', coverageRequest.id)
      .eq('correlation_id', created.id)
      .eq('event_type', 'coverage.request.approved')
      .maybeSingle()
    if (eventReadError) throw eventReadError

    expect(eventBeforeSend).toMatchObject({
      delivery_mode: 'active',
      status: 'pending',
      legacy_notification_id: null,
      local_message_id: null,
      sent_at: null,
    })

    const { count: legacyCountBefore, error: legacyBeforeError } = await db
      .from('customer_intent_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('change_request_id', created.id)
    if (legacyBeforeError) throw legacyBeforeError
    expect(legacyCountBefore).toBe(0)

    const delivered =
      await deliverActiveSubjectBusinessEventNotifications({
        accountId,
        subjectType: 'coverage_request',
        subjectId: coverageRequest.id,
        correlationId: created.id,
        limit: 5,
      })

    expect(delivered.claimed).toBe(1)
    expect(delivered.sent).toBe(1)
    expect(delivered.failed).toBe(0)
    expect(delivered.reconciliation).toBe(0)

    const { data: eventAfterSend, error: eventAfterError } = await db
      .from('business_event_outbox')
      .select(
        'status, attempts, local_message_id, sent_at, legacy_notification_id',
      )
      .eq('account_id', accountId)
      .eq('id', eventBeforeSend?.id)
      .maybeSingle()
    if (eventAfterError) throw eventAfterError

    expect(eventAfterSend?.status).toBe('sent')
    expect(eventAfterSend?.attempts).toBe(1)
    expect(eventAfterSend?.local_message_id).toBeTruthy()
    expect(eventAfterSend?.sent_at).toBeTruthy()
    expect(eventAfterSend?.legacy_notification_id).toBeNull()

    const replay =
      await deliverActiveSubjectBusinessEventNotifications({
        accountId,
        subjectType: 'coverage_request',
        subjectId: coverageRequest.id,
        correlationId: created.id,
        limit: 5,
      })

    expect(replay.claimed).toBe(0)
    expect(replay.sent).toBe(0)
  }, 120_000)
})
