import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentFxRate: vi.fn(),
  getFxBaseCurrency: vi.fn(),
  createFxTradeRequest: vi.fn(),
  createChangeRequest: vi.fn(),
}))

vi.mock('@/lib/services/fx-v2/service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/fx-v2/service')>(
    '@/lib/services/fx-v2/service',
  )
  return {
    ...actual,
    getCurrentFxRate: mocks.getCurrentFxRate,
    getFxBaseCurrency: mocks.getFxBaseCurrency,
    createFxTradeRequest: mocks.createFxTradeRequest,
  }
})

vi.mock('@/lib/ai/runtime/change-requests-service', () => ({
  createChangeRequest: mocks.createChangeRequest,
}))

import {
  executeFxV2GetCurrent,
  executeFxV2RecordTradeRequest,
  fxTradeSideFromIntent,
} from './fx-v2-tools'
import type { ToolContext } from './executors'

const pair = {
  id: 'pair-1',
  accountId: 'account-1',
  base: {
    id: 'currency-sar',
    code: 'SAR',
    displayName: 'Saudi Riyal',
    symbol: 'SAR',
    decimalDigits: 2,
    status: 'active' as const,
  },
  quote: {
    id: 'currency-yer',
    code: 'YER',
    displayName: 'Yemeni Rial',
    symbol: 'YER',
    decimalDigits: 2,
    status: 'active' as const,
  },
  status: 'active' as const,
  currentRateVersionId: 'rate-v1',
  lockVersion: 1,
  createdAt: '2026-09-16T00:00:00.000Z',
  updatedAt: '2026-09-16T00:00:00.000Z',
}

const currentRate = {
  pair,
  rateVersionId: 'rate-v1',
  versionNumber: 1,
  businessBuyRate: '425.00000000',
  businessSellRate: '428.00000000',
  source: 'manual' as const,
  publishedAt: '2026-09-16T12:00:00.000Z',
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    accountId: 'account-1',
    agentId: 'agent-1',
    revisionId: 'revision-1',
    actorUserId: null,
    runId: 'run-1',
    grants: {},
    grantVersions: {},
    grantConstraints: {},
    plane: 'customer',
    channel: 'whatsapp',
    simulation: false,
    trustedAdminIdentityId: null,
    trustedAdminCapabilities: [],
    features: {
      killSwitch: false,
      nativeToolsEnabled: true,
      proposalToolsEnabled: true,
    },
    agentPurpose: 'customer_support',
    contactId: 'contact-1',
    conversationId: 'conversation-1',
    sourceMessageId: 'message-1',
    ...overrides,
  }
}

describe('FX V2 customer runtime tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getCurrentFxRate.mockResolvedValue(currentRate)
    mocks.getFxBaseCurrency.mockResolvedValue(pair.quote)
    mocks.createFxTradeRequest.mockResolvedValue({
      requestId: 'trade-1',
      code: '42',
      rateVersionId: 'rate-v1',
      effectiveRate: '428.00000000',
      baseAmount: '1000.00',
      quoteAmount: '428000.00',
      status: 'pending_admin',
      idempotent: false,
    })
    mocks.createChangeRequest.mockResolvedValue({
      id: 'change-1',
      code: 73,
      confirmationCode: '4821',
      status: 'pending',
      contentDigest: 'digest-1',
    })
  })

  it('maps customer buy/sell semantics to the deterministic FX side', () => {
    expect(fxTradeSideFromIntent('customer_buys_base')).toBe('customer_buy')
    expect(fxTradeSideFromIntent('customer_sells_base')).toBe('customer_sell')
  })

  it('reads the authoritative V2 current version and exposes only the effective customer rate', async () => {
    const result = await executeFxV2GetCurrent(context(), {
      base_currency: 'sar',
      quote_currency: 'yer',
      intent: 'customer_buys_base',
      region: 'Sanaa',
      settlement: 'cash',
    })

    expect(mocks.getCurrentFxRate).toHaveBeenCalledWith('account-1', 'SAR', 'YER')
    expect(result).toEqual({
      ok: true,
      safe_to_show: true,
      data: {
        status: 'current',
        pair_id: 'pair-1',
        base_currency: 'SAR',
        quote_currency: 'YER',
        quote_currency_defaulted: false,
        customer_side: 'customer_buys_base',
        effective_rate: '428.00000000',
        rate_version_id: 'rate-v1',
        version_number: 1,
        published_at: '2026-09-16T12:00:00.000Z',
        meaning: 'Customer buys SAR; business sell rate applies.',
      },
    })
  })

  it('creates a pending FX trade and immediately opens the trusted-admin review gate', async () => {
    const result = await executeFxV2RecordTradeRequest(context(), {
      base_currency: 'SAR',
      quote_currency: 'YER',
      intent: 'customer_buys_base',
      base_amount: '1000',
      expected_rate_version_id: 'rate-v1',
    })

    expect(mocks.createFxTradeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'account-1',
        pairId: 'pair-1',
        side: 'customer_buy',
        amountBasis: 'base',
        requestedAmount: '1000',
        expectedRateVersionId: 'rate-v1',
        contactId: 'contact-1',
        conversationId: 'conversation-1',
        idempotencyKey: expect.stringContaining('message-1:pair-1:customer_buy:1000:rate-v1'),
        metadata: expect.objectContaining({
          source: 'ai_runtime',
          tool: 'exchange_rates.record_trade_request',
          source_message_id: 'message-1',
          quoted_rate_version_id: 'rate-v1',
        }),
      }),
    )
    expect(mocks.createChangeRequest).toHaveBeenCalledWith({
      accountId: 'account-1',
      targetType: 'fx_trade_request',
      targetId: 'trade-1',
      intent: 'update',
      proposedPayload: {
        expected_status: 'pending_admin',
        decision: 'approve',
        note: null,
        rate_version_id: 'rate-v1',
        contact_id: 'contact-1',
        conversation_id: 'conversation-1',
        requested_amount: '1000.00',
        currency: 'SAR',
        base_currency: 'SAR',
        quote_currency: 'YER',
        customer_side: 'customer_buys_base',
        effective_rate: '428.00000000',
        base_amount: '1000.00',
        quote_amount: '428000.00',
        trade_code: '42',
      },
      idempotencyKey: 'fx-trade-review:trade-1:pending_admin',
      summary: 'طلب شراء عملة FX-42: 1000.00 SAR مقابل 428000.00 YER بسعر 428.00000000',
      actorUserId: null,
    })
    expect(result).toEqual({
      ok: true,
      safe_to_show: true,
      data: {
        trade_request: {
          request_id: 'trade-1',
          code: '42',
          status: 'pending_admin',
          pair_id: 'pair-1',
          base_currency: 'SAR',
          quote_currency: 'YER',
          customer_side: 'customer_buys_base',
          rate_version_id: 'rate-v1',
          effective_rate: '428.00000000',
          base_amount: '1000.00',
          quote_amount: '428000.00',
          idempotent: false,
        },
        admin_review: {
          status: 'pending',
          forwarded_to_admin: true,
        },
      },
    })
  })

  it('does not create a fresh admin review when an idempotent trade is already decided', async () => {
    mocks.createFxTradeRequest.mockResolvedValueOnce({
      requestId: 'trade-1',
      code: '42',
      rateVersionId: 'rate-v1',
      effectiveRate: '428.00000000',
      baseAmount: '1000.00',
      quoteAmount: '428000.00',
      status: 'approved_for_contact',
      idempotent: true,
    })

    const result = await executeFxV2RecordTradeRequest(context(), {
      base_currency: 'SAR',
      quote_currency: 'YER',
      intent: 'customer_buys_base',
      base_amount: '1000',
      expected_rate_version_id: 'rate-v1',
    })

    expect(mocks.createChangeRequest).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: true,
      data: {
        trade_request: {
          status: 'approved_for_contact',
          idempotent: true,
        },
      },
    })
  })

  it('requires a rate version from the preceding current-rate quote', async () => {
    const result = await executeFxV2RecordTradeRequest(
      context(),
      {
        base_currency: 'SAR',
        quote_currency: 'YER',
        intent: 'customer_buys_base',
        base_amount: '1000',
      } as never,
    )

    expect(mocks.getCurrentFxRate).not.toHaveBeenCalled()
    expect(mocks.createFxTradeRequest).not.toHaveBeenCalled()
    expect(mocks.createChangeRequest).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: false,
      safe_to_show: true,
      code: 'FX_QUOTED_RATE_VERSION_REQUIRED',
    })
  })

  it('rejects a stale quoted version before creating the trade request', async () => {
    const result = await executeFxV2RecordTradeRequest(context(), {
      base_currency: 'SAR',
      quote_currency: 'YER',
      intent: 'customer_sells_base',
      base_amount: '500',
      expected_rate_version_id: 'rate-old',
    })

    expect(mocks.createFxTradeRequest).not.toHaveBeenCalled()
    expect(mocks.createChangeRequest).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: false,
      safe_to_show: true,
      code: 'FX_RATE_VERSION_CONFLICT',
    })
  })

  it('refuses trade creation without server-bound customer identity', async () => {
    const result = await executeFxV2RecordTradeRequest(
      context({ contactId: null }),
      {
        base_currency: 'SAR',
        quote_currency: 'YER',
        intent: 'customer_buys_base',
        base_amount: '1000',
        expected_rate_version_id: 'rate-v1',
      },
    )

    expect(mocks.createFxTradeRequest).not.toHaveBeenCalled()
    expect(mocks.createChangeRequest).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: false,
      safe_to_show: false,
      code: 'CUSTOMER_CONTEXT_MISSING',
    })
  })
})
