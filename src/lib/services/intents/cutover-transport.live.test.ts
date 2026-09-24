import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { approveChangeRequest } from '@/lib/ai/runtime/change-requests-service'
import { executeApprovedChangeRequest } from '@/lib/ai/runtime/change-request-executor'
import { deliverActiveSubjectBusinessEventNotifications } from '@/lib/ai/runtime/customer-notification-delivery'
import { recordIntent } from './intents-service'
import { inspectIntentsBusinessEventCutoverReadiness } from './cutover'

const enabled =
  process.env.WACRM_INTENTS_CUTOVER_TRANSPORT_E2E_LIVE === '1'
const liveDescribe = enabled ? describe : describe.skip

let accountIdForCleanup: string | null = null
let previousRecoveryWorker: boolean | null = null
const touchedChangeRequestIds = new Set<string>()

liveDescribe('Intents active WhatsApp transport E2E on TEST', () => {
  afterEach(async () => {
    if (!accountIdForCleanup || previousRecoveryWorker == null) return

    const db = supabaseAdmin()
    if (touchedChangeRequestIds.size > 0) {
      await db
        .from('customer_intent_notifications')
        .update({ claim_token: null })
        .eq('account_id', accountIdForCleanup)
        .in('change_request_id', [...touchedChangeRequestIds])
    }

    await db
      .from('ai_runtime_policies')
      .update({ recovery_worker_enabled: previousRecoveryWorker })
      .eq('account_id', accountIdForCleanup)
  })

  it('sends one active canonical Intents event and suppresses the legacy duplicate', async () => {
    if (
      process.env.WACRM_INTENTS_CUTOVER_TRANSPORT_E2E_CONFIRM !==
      'SEND_TEST_WHATSAPP'
    ) {
      throw new Error(
        'WACRM_INTENTS_CUTOVER_TRANSPORT_E2E_CONFIRMATION_REQUIRED',
      )
    }

    const accountId = process.env.WACRM_INTENTS_CUTOVER_LIVE_ACCOUNT_ID
    const contactId =
      process.env.WACRM_INTENTS_CUTOVER_TEST_CONTACT_ID
    const conversationId =
      process.env.WACRM_INTENTS_CUTOVER_TEST_CONVERSATION_ID

    if (!accountId || !contactId || !conversationId) {
      throw new Error(
        'WACRM_INTENTS_CUTOVER_TEST_RECIPIENT_IDS_REQUIRED',
      )
    }
    if (
      !process.env.NEXT_PUBLIC_SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY
    ) {
      throw new Error('SUPABASE_TEST_ENV_REQUIRED')
    }

    accountIdForCleanup = accountId
    const db = supabaseAdmin()

    const readiness = await inspectIntentsBusinessEventCutoverReadiness({
      accountId,
    })
    expect(readiness.mode).toBe('active')
    expect(readiness.ready).toBe(true)

    const { data: recipient, error: recipientError } = await db
      .from('conversations')
      .select('id, contact_id, account_id')
      .eq('account_id', accountId)
      .eq('id', conversationId)
      .eq('contact_id', contactId)
      .maybeSingle()
    if (recipientError) throw recipientError
    if (!recipient) {
      throw new Error('WACRM_INTENTS_CUTOVER_TEST_RECIPIENT_NOT_FOUND')
    }

    const { data: account, error: accountError } = await db
      .from('accounts')
      .select('owner_user_id')
      .eq('id', accountId)
      .maybeSingle()
    if (accountError) throw accountError
    if (!account?.owner_user_id) {
      throw new Error('INTENTS_CUTOVER_TEST_ACCOUNT_OWNER_REQUIRED')
    }
    const actorUserId = account.owner_user_id as string

    const { data: policy, error: policyError } = await db
      .from('ai_runtime_policies')
      .select('recovery_worker_enabled')
      .eq('account_id', accountId)
      .maybeSingle()
    if (policyError) throw policyError
    if (!policy) throw new Error('INTENTS_CUTOVER_RUNTIME_POLICY_REQUIRED')
    previousRecoveryWorker = policy.recovery_worker_enabled === true

    const { error: pauseError } = await db
      .from('ai_runtime_policies')
      .update({ recovery_worker_enabled: false })
      .eq('account_id', accountId)
    if (pauseError) throw pauseError

    const runId = randomUUID()
    const recorded = await recordIntent({
      accountId,
      contactId,
      conversationId,
      direction: 'request',
      serviceHint: `cutover-active-transport-${runId}`,
      summary:
        'Service Platform V2 active Intents transport E2E fixture.',
      attributes: {
        test_fixture: true,
        purpose: 'service_platform_v2_intents_active_transport',
      },
      escalateToAdmin: false,
      actorUserId,
    })

    const { data: createdRows, error: createError } = await db.rpc(
      'create_change_request_v3',
      {
        p_account_id: accountId,
        p_action_key: 'intents.decision.apply',
        p_action_version: 1,
        p_target_type: 'service_intent',
        p_target_id: recorded.intentId,
        p_intent: 'update',
        p_proposed_payload: { decision: 'fulfilled' },
        p_expected_version: null,
        p_idempotency_key:
          `intents-cutover-active-transport:${recorded.intentId}`,
        p_summary: '[TEST] Intents active transport E2E',
        p_actor_user_id: actorUserId,
      },
    )
    if (createError) throw createError

    const created = (
      createdRows as Array<{
        id: string
        confirmation_code: string | null
      }> | null
    )?.[0]
    if (!created?.id || !created.confirmation_code) {
      throw new Error('INTENTS_CUTOVER_CHANGE_REQUEST_CREATE_FAILED')
    }
    touchedChangeRequestIds.add(created.id)

    await approveChangeRequest({
      accountId,
      changeRequestId: created.id,
      confirmationCode: created.confirmation_code,
      actorUserId,
    })

    await executeApprovedChangeRequest({
      accountId,
      changeRequestId: created.id,
      actorUserId,
    })

    const { data: eventBeforeSend, error: eventReadError } = await db
      .from('business_event_outbox')
      .select('id, delivery_mode, status, legacy_notification_id')
      .eq('account_id', accountId)
      .eq('subject_type', 'service_intent')
      .eq('subject_id', recorded.intentId)
      .eq('correlation_id', created.id)
      .eq('event_type', 'service_request.approved')
      .maybeSingle()
    if (eventReadError) throw eventReadError
    expect(eventBeforeSend).toMatchObject({
      delivery_mode: 'active',
      status: 'pending',
    })
    expect(eventBeforeSend?.legacy_notification_id).toBeTruthy()

    const delivered =
      await deliverActiveSubjectBusinessEventNotifications({
        accountId,
        subjectType: 'service_intent',
        subjectId: recorded.intentId,
        correlationId: created.id,
        limit: 5,
      })

    expect(delivered.claimed).toBe(1)
    expect(delivered.sent).toBe(1)
    expect(delivered.failed).toBe(0)
    expect(delivered.reconciliation).toBe(0)

    const { data: eventAfterSend, error: eventAfterError } = await db
      .from('business_event_outbox')
      .select('status, local_message_id, sent_at, legacy_notification_id')
      .eq('account_id', accountId)
      .eq('id', eventBeforeSend?.id)
      .maybeSingle()
    if (eventAfterError) throw eventAfterError

    expect(eventAfterSend?.status).toBe('sent')
    expect(eventAfterSend?.local_message_id).toBeTruthy()
    expect(eventAfterSend?.sent_at).toBeTruthy()

    const { data: legacyAfterSend, error: legacyError } = await db
      .from('customer_intent_notifications')
      .select('status, local_message_id, sent_at')
      .eq('account_id', accountId)
      .eq('id', eventAfterSend?.legacy_notification_id)
      .maybeSingle()
    if (legacyError) throw legacyError

    expect(legacyAfterSend).toMatchObject({
      status: 'sent',
      local_message_id: eventAfterSend?.local_message_id,
    })
    expect(legacyAfterSend?.sent_at).toBeTruthy()

    // A second subject-scoped pass must have nothing left to claim. This proves
    // the active event and its linked legacy row did not create two sends.
    const replay =
      await deliverActiveSubjectBusinessEventNotifications({
        accountId,
        subjectType: 'service_intent',
        subjectId: recorded.intentId,
        correlationId: created.id,
        limit: 5,
      })

    expect(replay.claimed).toBe(0)
    expect(replay.sent).toBe(0)
  }, 120_000)
})
