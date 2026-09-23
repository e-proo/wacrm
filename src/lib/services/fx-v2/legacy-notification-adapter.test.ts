import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(),
  renderFxTradeBusinessEventText: vi.fn(),
  maybeSingle: vi.fn(),
}))

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}))

vi.mock('@/lib/messaging/fx-v2-outbox', () => ({
  renderFxTradeBusinessEventText: mocks.renderFxTradeBusinessEventText,
}))

import { FX_V2_LEGACY_NOTIFICATION_RENDERER } from './legacy-notification-adapter'

function installQuery() {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: mocks.maybeSingle,
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  mocks.supabaseAdmin.mockReturnValue({
    from: vi.fn().mockReturnValue(query),
  })
}

describe('FX V2 legacy notification adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installQuery()
  })

  it('declines legacy rows that do not belong to an FX trade', async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { fx_trade_request_id: null, event_type: 'approved_and_applied' },
      error: null,
    })

    await expect(
      FX_V2_LEGACY_NOTIFICATION_RENDERER.render({
        accountId: 'acc-1',
        notification: {
          id: 'notification-1',
          intentId: 'intent-1',
          eventType: 'approved_and_applied',
        },
      }),
    ).resolves.toBeNull()

    expect(mocks.renderFxTradeBusinessEventText).not.toHaveBeenCalled()
  })

  it('owns FX legacy rows and delegates to the historical deterministic renderer', async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: {
        fx_trade_request_id: 'trade-1',
        event_type: 'exchange_rate.trade.approved',
      },
      error: null,
    })
    mocks.renderFxTradeBusinessEventText.mockResolvedValue('rendered fx')

    await expect(
      FX_V2_LEGACY_NOTIFICATION_RENDERER.render({
        accountId: 'acc-1',
        notification: {
          id: 'notification-1',
          intentId: null,
          eventType: 'exchange_rate.trade.approved',
        },
      }),
    ).resolves.toBe('rendered fx')

    expect(mocks.renderFxTradeBusinessEventText).toHaveBeenCalledWith({
      accountId: 'acc-1',
      tradeRequestId: 'trade-1',
      eventType: 'exchange_rate.trade.approved',
    })
  })
})
