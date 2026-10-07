import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { deliverActiveSubjectBusinessEventNotifications } from '@/lib/ai/runtime/customer-notification-delivery'
import {
  cancelFxTradeRequest,
  createFxTradeRequest,
  listFxPairs,
} from './service'
import { inspectFxBusinessEventCutoverReadiness } from './cutover'

const enabled =
  process.env.WACRM_FX_CUTOVER_TRANSPORT_E2E_LIVE === '1'
const liveDescribe = enabled ? describe : describe.skip

let accountIdForCleanup: string | null = null
let requestIdForCleanup: string | null = null
let previousRecoveryWorker: boolean | null = null

liveDescribe('FX active WhatsApp transport E2E on TEST', () => {
  afterEach(async () => {
    if (!accountIdForCleanup) return

    const db = supabaseAdmin()

    if (requestIdForCleanup) {
      const { data: request } = await db
        .from('exchange_trade_requests')
        .select('status')
        .eq('account_id', accountIdForCleanup)
        .eq('id', requestIdForCleanup)
        .maybeSingle()

      if (
        request?.status === 'pending_admin' ||
        request?.status === 'approved_for_contact'
      ) {
        try {
          await cancelFxTradeRequest({
            accountId: accountIdForCleanup,
            requestId: requestIdForCleanup,
            actorUserId: null,
          })
        } catch {
          // Keep cleanup best-effort; the assertion failure remains primary.
        }
      }
    }

    if (previousRecoveryWorker != null) {
      await db
        .from('ai_runtime_policies')
        .update({ recovery_worker_enabled: previousRecoveryWorker })
        .eq('account_id', accountIdForCleanup)
    }
  })

  it('sends one current canonical FX event and remains idempotent on replay', async () => {
    if (
      process.env.WACRM_FX_CUTOVER_TRANSPORT_E2E_CONFIRM !==
      'SEND_TEST_WHATSAPP'
    ) {
      throw new Error(
        'WACRM_FX_CUTOVER_TRANSPORT_E2E_CONFIRMATION_REQUIRED',
      )
    }

    const accountId = process.env.WACRM_FX_CUTOVER_LIVE_ACCOUNT_ID?.trim()
    const contactId = process.env.WACRM_FX_CUTOVER_TEST_CONTACT_ID?.trim()
    const conversationId =
      process.env.WACRM_FX_CUTOVER_TEST_CONVERSATION_ID?.trim()

    if (!accountId || !contactId || !conversationId) {
      throw new Error('WACRM_FX_CUTOVER_TEST_RECIPIENT_IDS_REQUIRED')
    }
    if (
      !process.env.NEXT_PUBLIC_SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY
    ) {
      throw new Error('SUPABASE_TEST_ENV_REQUIRED')
    }

    accountIdForCleanup = accountId
    const db = supabaseAdmin()

    const readiness = await inspectFxBusinessEventCutoverReadiness({
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
      .eq('route_key', 'fx_trade_customer_whatsapp')
      .maybeSingle()
    if (deliveryControlError) throw deliveryControlError
    if (!deliveryControl) {
      throw new Error('FX_CUTOVER_DELIVERY_CONTROL_REQUIRED')
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
      throw new Error('WACRM_FX_CUTOVER_TEST_RECIPIENT_NOT_FOUND')
    }

    const { data: policy, error: policyError } = await db
      .from('ai_runtime_policies')
      .select('recovery_worker_enabled')
      .eq('account_id', accountId)
      .maybeSingle()
    if (policyError) throw policyError
    if (!policy) throw new Error('FX_CUTOVER_RUNTIME_POLICY_REQUIRED')
    previousRecoveryWorker = policy.recovery_worker_enabled === true

    const { error: pauseError } = await db
      .from('ai_runtime_policies')
      .update({ recovery_worker_enabled: false })
      .eq('account_id', accountId)
    if (pauseError) throw pauseError

    const pairs = await listFxPairs(accountId)
    const pair = pairs.find(
      (candidate) =>
        candidate.status === 'active' && Boolean(candidate.currentRateVersionId),
    )
    if (!pair?.currentRateVersionId) {
      throw new Error('FX_CUTOVER_ACTIVE_RATED_PAIR_REQUIRED')
    }

    const fixtureKey = randomUUID()
    const created = await createFxTradeRequest({
      accountId,
      pairId: pair.id,
      side: 'customer_buy',
      amountBasis: 'base',
      requestedAmount: '1',
      idempotencyKey: `phase6-fx-transport:${fixtureKey}`,
      expectedRateVersionId: pair.currentRateVersionId,
      contactId,
      conversationId,
      metadata: {
        test_fixture: true,
        purpose: 'service_platform_v2_fx_active_transport',
      },
    })
    requestIdForCleanup = created.requestId

    expect(created.status).toBe('pending_admin')
    expect(created.idempotent).toBe(false)

    const { data: eventBeforeSend, error: eventReadError } = await db
      .from('business_event_outbox')
      .select(
        'id, delivery_mode, status, legacy_notification_id, local_message_id, sent_at',
      )
      .eq('account_id', accountId)
      .eq('subject_type', 'fx_trade_request')
      .eq('subject_id', created.requestId)
      .eq('event_type', 'exchange_rate.trade.requested')
      .maybeSingle()
    if (eventReadError) throw eventReadError

    expect(eventBeforeSend).toMatchObject({
      delivery_mode: 'active',
      status: 'pending',
      legacy_notification_id: null,
      local_message_id: null,
      sent_at: null,
    })

    const delivered =
      await deliverActiveSubjectBusinessEventNotifications({
        accountId,
        subjectType: 'fx_trade_request',
        subjectId: created.requestId,
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
        subjectType: 'fx_trade_request',
        subjectId: created.requestId,
        limit: 5,
      })

    expect(replay.claimed).toBe(0)
    expect(replay.sent).toBe(0)
  }, 120_000)
})
