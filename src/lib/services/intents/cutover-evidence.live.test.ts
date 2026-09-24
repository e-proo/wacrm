import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import {
  approveChangeRequest,
} from '@/lib/ai/runtime/change-requests-service'
import { executeApprovedChangeRequest } from '@/lib/ai/runtime/change-request-executor'
import { recordIntent } from './intents-service'
import {
  INTENTS_CUSTOMER_BUSINESS_EVENT_TYPES,
  inspectIntentsBusinessEventCutoverReadiness,
  prepareIntentsBusinessEventShadowVerification,
} from './cutover'

const enabled = process.env.WACRM_INTENTS_CUTOVER_EVIDENCE_LIVE === '1'
const liveDescribe = enabled ? describe : describe.skip

interface RuntimePolicySnapshot {
  exists: boolean
  recoveryWorkerEnabled: boolean
}

const touchedChangeRequestIds = new Set<string>()
let policySnapshot: RuntimePolicySnapshot | null = null
let accountIdForCleanup: string | null = null

liveDescribe('Intents cutover TEST evidence generation', () => {
  afterEach(async () => {
    const accountId = accountIdForCleanup
    if (!accountId) return
    const db = supabaseAdmin()

    // Never leave a fixture notification claimable if the test aborts halfway.
    if (touchedChangeRequestIds.size > 0) {
      await db
        .from('customer_intent_notifications')
        .update({
          status: 'sent',
          claim_token: null,
          last_error: null,
          sent_at: new Date().toISOString(),
        })
        .eq('account_id', accountId)
        .in('change_request_id', [...touchedChangeRequestIds])
    }

    if (policySnapshot?.exists) {
      await db
        .from('ai_runtime_policies')
        .update({
          recovery_worker_enabled: policySnapshot.recoveryWorkerEnabled,
        })
        .eq('account_id', accountId)
    }
  })

  it('creates real Intents-owned outcomes through approval/execution and proves 4/4 shadow parity', async () => {
    if (
      process.env.WACRM_INTENTS_CUTOVER_EVIDENCE_CONFIRM !==
      'GENERATE_TEST_EVIDENCE'
    ) {
      throw new Error('WACRM_INTENTS_CUTOVER_EVIDENCE_CONFIRMATION_REQUIRED')
    }

    const accountId = process.env.WACRM_INTENTS_CUTOVER_LIVE_ACCOUNT_ID
    if (!accountId) {
      throw new Error('WACRM_INTENTS_CUTOVER_LIVE_ACCOUNT_ID_REQUIRED')
    }
    if (
      !process.env.NEXT_PUBLIC_SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY
    ) {
      throw new Error('SUPABASE_TEST_ENV_REQUIRED')
    }

    accountIdForCleanup = accountId
    const db = supabaseAdmin()

    const before = await inspectIntentsBusinessEventCutoverReadiness({
      accountId,
    })
    expect(before.mode).toBe('legacy')

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
    policySnapshot = {
      exists: Boolean(policy),
      recoveryWorkerEnabled: policy?.recovery_worker_enabled === true,
    }
    if (policy) {
      const { error } = await db
        .from('ai_runtime_policies')
        .update({ recovery_worker_enabled: false })
        .eq('account_id', accountId)
      if (error) throw error
    }

    const sinkPhone = 'TEST_INTENTS_CUTOVER_NO_TRANSPORT'
    const { data: existingContact, error: contactReadError } = await db
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .eq('phone', sinkPhone)
      .maybeSingle()
    if (contactReadError) throw contactReadError

    let contactId = existingContact?.id as string | undefined
    if (!contactId) {
      const { data: createdContact, error: contactCreateError } = await db
        .from('contacts')
        .insert({
          account_id: accountId,
          user_id: actorUserId,
          phone: sinkPhone,
          name: '[TEST] Intents Cutover Sink — DO NOT MESSAGE',
        })
        .select('id')
        .single()
      if (contactCreateError) throw contactCreateError
      contactId = createdContact.id as string
    }

    const { data: existingConversation, error: conversationReadError } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (conversationReadError) throw conversationReadError

    let conversationId = existingConversation?.id as string | undefined
    if (!conversationId) {
      const { data: createdConversation, error: conversationCreateError } =
        await db
          .from('conversations')
          .insert({
            account_id: accountId,
            user_id: actorUserId,
            contact_id: contactId,
            status: 'open',
            ai_autoreply_disabled: true,
          })
          .select('id')
          .single()
      if (conversationCreateError) throw conversationCreateError
      conversationId = createdConversation.id as string
    }

    const { data: matchedService, error: serviceError } = await db
      .from('services')
      .select('id')
      .eq('account_id', accountId)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle()
    if (serviceError) throw serviceError
    if (!matchedService?.id) {
      throw new Error('INTENTS_CUTOVER_ACTIVE_SERVICE_REQUIRED')
    }

    const runId = randomUUID()
    const scenarios = [
      { decision: 'fulfilled' as const },
      { decision: 'rejected' as const },
      {
        decision: 'matched' as const,
        matchedServiceId: matchedService.id as string,
      },
      { decision: 'clarifying' as const },
    ]

    for (const scenario of scenarios) {
      const recorded = await recordIntent({
        accountId,
        contactId,
        conversationId,
        direction: 'request',
        serviceHint: `cutover-evidence-${scenario.decision}-${runId}`,
        summary: 'Service Platform V2 controlled Intents cutover evidence.',
        attributes: {
          test_fixture: true,
          purpose: 'service_platform_v2_intents_cutover',
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
          p_proposed_payload: {
            decision: scenario.decision,
            ...(scenario.matchedServiceId
              ? { matched_service_id: scenario.matchedServiceId }
              : {}),
          },
          p_expected_version: null,
          p_idempotency_key:
            `intents-cutover-evidence:${recorded.intentId}:${scenario.decision}`,
          p_summary:
            `[TEST] Intents cutover evidence: ${scenario.decision}`,
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

      // Shadow parity verifies rendering, not transport. Keep the real legacy
      // compatibility row terminal so an external worker can never message the
      // sink fixture while this evidence remains in TEST.
      const { error: terminalError } = await db
        .from('customer_intent_notifications')
        .update({
          status: 'sent',
          claim_token: null,
          last_error: null,
          sent_at: new Date().toISOString(),
        })
        .eq('account_id', accountId)
        .eq('change_request_id', created.id)
      if (terminalError) throw terminalError
    }

    const evidence = await prepareIntentsBusinessEventShadowVerification({
      accountId,
      limit: 100,
    })

    expect(evidence.rendering.failed).toBe(0)
    expect(evidence.rendering.unsupportedProjector).toBe(0)
    expect(evidence.rendering.mismatchedLegacy).toBe(0)
    expect(evidence.rendering.comparisonMissing).toBe(0)
    expect(evidence.readiness.matchedEventTypes).toBe(
      INTENTS_CUSTOMER_BUSINESS_EVENT_TYPES.length,
    )
    expect(evidence.readiness.matchedEventTypeKeys).toEqual(
      expect.arrayContaining([...INTENTS_CUSTOMER_BUSINESS_EVENT_TYPES]),
    )
    expect(evidence.readiness.missingEventTypes).toEqual([])
    expect(evidence.readiness.blockers).toBe(0)
    expect(evidence.readiness.legacyNonterminal).toBe(0)
    expect(evidence.readiness.activeNonterminal).toBe(0)
    expect(evidence.readiness.ready).toBe(true)
  }, 120_000)
})
