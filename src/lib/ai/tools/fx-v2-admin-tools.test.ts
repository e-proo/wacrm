import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listFxPairs: vi.fn(),
  getCurrentFxRateByPair: vi.fn(),
  listFxTradeRequests: vi.fn(),
  createChangeRequest: vi.fn(),
  findChangeRequestByIdempotencyKey: vi.fn(),
}))

vi.mock('@/lib/services/fx-v2/service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/fx-v2/service')>(
    '@/lib/services/fx-v2/service',
  )
  return {
    ...actual,
    listFxPairs: mocks.listFxPairs,
    getCurrentFxRateByPair: mocks.getCurrentFxRateByPair,
  }
})

vi.mock('@/lib/services/fx-v2/dashboard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/fx-v2/dashboard')>(
    '@/lib/services/fx-v2/dashboard',
  )
  return {
    ...actual,
    listFxTradeRequests: mocks.listFxTradeRequests,
  }
})

vi.mock('@/lib/ai/runtime/change-requests-service', () => ({
  createChangeRequest: mocks.createChangeRequest,
  findChangeRequestByIdempotencyKey: mocks.findChangeRequestByIdempotencyKey,
}))

import {
  executeFxV2AdminListPairs,
  executeFxV2AdminListTradeRequests,
  executeFxV2ProposePairChange,
  executeFxV2ProposeTradeDecision,
} from './fx-v2-admin-tools'
import type { ToolContext } from './executors'

const pair = {
  id: 'pair-1',
  accountId: 'account-1',
  base: {
    id: 'currency-sar', code: 'SAR', displayName: 'Saudi Riyal', symbol: 'SAR',
    decimalDigits: 2, status: 'active' as const,
  },
  quote: {
    id: 'currency-yer', code: 'YER', displayName: 'Yemeni Rial', symbol: 'YER',
    decimalDigits: 2, status: 'active' as const,
  },
  status: 'active' as const,
  currentRateVersionId: 'rate-v1',
  lockVersion: 3,
  createdAt: '2026-09-16T00:00:00.000Z',
  updatedAt: '2026-09-16T12:00:00.000Z',
}

function adminContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    accountId: 'account-1',
    agentId: 'admin-agent-1',
    revisionId: 'admin-revision-1',
    actorUserId: 'user-admin-1',
    runId: 'run-admin-1',
    grants: {},
    grantVersions: {},
    grantConstraints: {},
    plane: 'admin',
    channel: 'whatsapp',
    simulation: false,
    trustedAdminIdentityId: 'trusted-admin-1',
    trustedAdminCapabilities: ['rates.read', 'rates.propose'],
    features: {
      killSwitch: false,
      nativeToolsEnabled: true,
      proposalToolsEnabled: true,
    },
    agentPurpose: 'admin_operations',
    contactId: null,
    conversationId: null,
    sourceMessageId: null,
    ...overrides,
  }
}

const trade = {
  id: 'trade-1',
  code: '42',
  pair,
  side: 'customer_buy' as const,
  amountBasis: 'base' as const,
  requestedAmount: '1000.00',
  rateVersionId: 'rate-v1',
  effectiveRate: '428.00000000',
  baseAmount: '1000.00',
  quoteAmount: '428000.00',
  status: 'pending_admin' as const,
  contactId: 'contact-1',
  conversationId: 'conversation-1',
  decisionChangeRequestId: null,
  decisionNote: null,
  decidedAt: null,
  completedAt: null,
  cancelledAt: null,
  createdAt: '2026-09-16T12:01:00.000Z',
  updatedAt: '2026-09-16T12:01:00.000Z',
}

describe('FX V2 Phase 5 admin tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listFxPairs.mockResolvedValue([pair])
    mocks.getCurrentFxRateByPair.mockResolvedValue({
      pair,
      rateVersionId: 'rate-v1',
      versionNumber: 1,
      businessBuyRate: '425.00000000',
      businessSellRate: '428.00000000',
      source: 'manual',
      publishedAt: '2026-09-16T12:00:00.000Z',
    })
    mocks.listFxTradeRequests.mockResolvedValue([trade])
    mocks.createChangeRequest.mockResolvedValue({
      id: 'cr-1',
      code: 101,
      confirmationCode: '987654',
      status: 'pending',
    })
    mocks.findChangeRequestByIdempotencyKey.mockResolvedValue(null)
  })

  it('lists explicit V2 pairs with current rate and optimistic lock', async () => {
    const result = await executeFxV2AdminListPairs(adminContext(), {})

    expect(mocks.listFxPairs).toHaveBeenCalledWith('account-1', { includeArchived: true })
    expect(result).toMatchObject({
      ok: true,
      safe_to_show: false,
      data: [
        {
          pair_id: 'pair-1',
          base_currency: 'SAR',
          quote_currency: 'YER',
          lock_version: 3,
          current_rate: {
            rate_version_id: 'rate-v1',
            business_buy_rate: '425.00000000',
            business_sell_rate: '428.00000000',
          },
        },
      ],
    })
  })

  it('rejects a stale pair lock before creating a proposal', async () => {
    const result = await executeFxV2ProposePairChange(adminContext(), {
      pair_id: 'pair-1',
      expected_lock_version: 2,
      business_buy_rate: '426',
      business_sell_rate: '429',
    })

    expect(mocks.createChangeRequest).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: false,
      code: 'FX_PAIR_VERSION_CONFLICT',
    })
  })

  it('creates an approval-bound pair proposal with exact V2 lock and rates', async () => {
    const result = await executeFxV2ProposePairChange(adminContext(), {
      pair_id: 'pair-1',
      expected_lock_version: 3,
      business_buy_rate: '426',
      business_sell_rate: '429',
      notes_internal: 'market update',
    })

    expect(mocks.createChangeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'account-1',
        targetType: 'fx_rate_pair',
        targetId: 'pair-1',
        intent: 'update',
        proposedPayload: {
          expected_lock_version: 3,
          business_buy_rate: '426',
          business_sell_rate: '429',
          notes_internal: 'market update',
        },
        actorUserId: 'user-admin-1',
      }),
    )
    expect(result).toMatchObject({
      ok: true,
      data: {
        pair: { pair_id: 'pair-1', expected_lock_version: 3 },
        proposed_rate: { business_buy_rate: '426', business_sell_rate: '429' },
        change_request: { id: 'cr-1', status: 'pending' },
      },
    })
  })

  it('lists pending V2 trade requests with immutable financial snapshots', async () => {
    const result = await executeFxV2AdminListTradeRequests(adminContext(), {
      status: 'pending_admin',
    })

    expect(mocks.listFxTradeRequests).toHaveBeenCalledWith('account-1', {
      status: 'pending_admin',
      limit: 50,
    })
    expect(result).toMatchObject({
      ok: true,
      data: [
        {
          request_id: 'trade-1',
          status: 'pending_admin',
          rate_version_id: 'rate-v1',
          effective_rate: '428.00000000',
          base_amount: '1000.00',
          quote_amount: '428000.00',
        },
      ],
    })
  })

  it('reuses the customer-created pending review for an approve decision', async () => {
    mocks.findChangeRequestByIdempotencyKey.mockResolvedValueOnce({
      id: 'review-cr-1',
      code: 73,
      status: 'pending',
      action_key: null,
      action_version: null,
      target_type: 'fx_trade_request',
      target_id: 'trade-1',
      proposed_payload: {
        expected_status: 'pending_admin',
        decision: 'approve',
      },
      idempotency_key: 'fx-trade-review:trade-1:pending_admin',
    })

    const result = await executeFxV2ProposeTradeDecision(adminContext(), {
      request_id: 'trade-1',
      decision: 'approve',
    })

    expect(mocks.findChangeRequestByIdempotencyKey).toHaveBeenCalledWith(
      'account-1',
      'fx-trade-review:trade-1:pending_admin',
    )
    expect(mocks.createChangeRequest).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: true,
      data: {
        proposed_decision: 'approve',
        change_request: {
          id: 'review-cr-1',
          code: 73,
          status: 'pending',
          confirmation_code: null,
          reused: true,
        },
      },
    })
  })

  it('reuses the same customer-created pending review for a reject decision', async () => {
    mocks.findChangeRequestByIdempotencyKey.mockResolvedValueOnce({
      id: 'review-cr-1',
      code: 73,
      status: 'pending',
      action_key: 'exchange_rates.trade.decide',
      action_version: 1,
      target_type: 'fx_trade_request',
      target_id: 'trade-1',
      proposed_payload: {
        expected_status: 'pending_admin',
        decision: 'approve',
      },
      idempotency_key: 'fx-trade-review:trade-1:pending_admin',
    })

    const result = await executeFxV2ProposeTradeDecision(adminContext(), {
      request_id: 'trade-1',
      decision: 'reject',
      note: 'decline request',
    })

    expect(mocks.findChangeRequestByIdempotencyKey).toHaveBeenCalledWith(
      'account-1',
      'fx-trade-review:trade-1:pending_admin',
    )
    expect(mocks.createChangeRequest).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: true,
      data: {
        proposed_decision: 'reject',
        change_request: {
          id: 'review-cr-1',
          code: 73,
          status: 'pending',
          confirmation_code: null,
          reused: true,
        },
      },
    })
  })

  it('fails closed when the pending FX review payload is no longer the original approve review', async () => {
    mocks.findChangeRequestByIdempotencyKey.mockResolvedValueOnce({
      id: 'review-cr-mutated',
      code: 75,
      status: 'pending',
      action_key: 'exchange_rates.trade.decide',
      action_version: 1,
      target_type: 'fx_trade_request',
      target_id: 'trade-1',
      proposed_payload: {
        expected_status: 'pending_admin',
        decision: 'reject',
      },
      idempotency_key: 'fx-trade-review:trade-1:pending_admin',
    })

    const result = await executeFxV2ProposeTradeDecision(adminContext(), {
      request_id: 'trade-1',
      decision: 'reject',
    })

    expect(mocks.createChangeRequest).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: false,
      code: 'FX_TRADE_REVIEW_CONFLICT',
    })
  })

  it('fails closed when a pending review idempotency key points at another contract', async () => {
    mocks.findChangeRequestByIdempotencyKey.mockResolvedValueOnce({
      id: 'review-cr-wrong',
      code: 74,
      status: 'pending',
      action_key: 'coverage.offer.create',
      action_version: 1,
      target_type: 'coverage_offer',
      target_id: 'offer-1',
      proposed_payload: {
        expected_status: 'pending_admin',
        decision: 'approve',
      },
      idempotency_key: 'fx-trade-review:trade-1:pending_admin',
    })

    const result = await executeFxV2ProposeTradeDecision(adminContext(), {
      request_id: 'trade-1',
      decision: 'reject',
    })

    expect(mocks.createChangeRequest).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: false,
      code: 'FX_TRADE_REVIEW_CONFLICT',
    })
  })

  it('creates an approval-bound approve decision without marking settlement complete', async () => {
    const result = await executeFxV2ProposeTradeDecision(adminContext(), {
      request_id: 'trade-1',
      decision: 'approve',
      note: 'contact customer',
    })

    expect(mocks.createChangeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'account-1',
        targetType: 'fx_trade_request',
        targetId: 'trade-1',
        intent: 'update',
        proposedPayload: {
          expected_status: 'pending_admin',
          decision: 'approve',
          note: 'contact customer',
          rate_version_id: 'rate-v1',
        },
      }),
    )
    expect(result).toMatchObject({
      ok: true,
      data: {
        proposed_decision: 'approve',
        trade_request: { request_id: 'trade-1', status: 'pending_admin' },
        change_request: { id: 'cr-1', status: 'pending' },
      },
    })
  })

  it('fails closed outside verified admin context', async () => {
    const result = await executeFxV2AdminListPairs(
      adminContext({ plane: 'customer', trustedAdminIdentityId: null }),
      {},
    )
    expect(result).toMatchObject({
      ok: false,
      safe_to_show: false,
      code: 'ADMIN_CONTEXT_REQUIRED',
    })
  })
})
