import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(),
  renderCoverageApprovedCustomerMessage: vi.fn(),
  createSupabaseTemplateOverrideStore: vi.fn(() => ({ store: true })),
  maybeSingle: vi.fn(),
}))

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}))

vi.mock('@/lib/messaging/coverage-customer', () => ({
  renderCoverageApprovedCustomerMessage:
    mocks.renderCoverageApprovedCustomerMessage,
}))

vi.mock('@/lib/messaging/supabase-store', () => ({
  createSupabaseTemplateOverrideStore:
    mocks.createSupabaseTemplateOverrideStore,
}))

import { COVERAGE_LEGACY_STRUCTURED_NOTIFICATION_RENDERER } from './legacy-notification-adapter'

function installRegionsQuery(rows: unknown[] = []) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  query.in.mockResolvedValue({ data: rows, error: null })
  const db = {
    from: vi.fn().mockReturnValue(query),
  }
  mocks.supabaseAdmin.mockReturnValue(db)
  return db
}

describe('Coverage legacy structured notification adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installRegionsQuery()
  })

  it('declines events outside Coverage approval outcomes', async () => {
    await expect(
      COVERAGE_LEGACY_STRUCTURED_NOTIFICATION_RENDERER.render({
        accountId: 'acc-1',
        eventKey: 'service_request.approved',
        payload: {},
      }),
    ).resolves.toBeNull()

    expect(mocks.renderCoverageApprovedCustomerMessage).not.toHaveBeenCalled()
  })

  it('resolves region labels and delegates Coverage legacy rendering', async () => {
    installRegionsQuery([
      { id: 'south-1', name: 'عدن', code: 'ADEN' },
      { id: 'north-1', name: 'صنعاء', code: 'SANA' },
    ])
    mocks.renderCoverageApprovedCustomerMessage.mockResolvedValue({
      text: 'rendered coverage',
      source: 'system',
      eventKey: 'coverage.offer.approved',
      resolvedLocale: 'ar',
    })

    await expect(
      COVERAGE_LEGACY_STRUCTURED_NOTIFICATION_RENDERER.render({
        accountId: 'acc-1',
        eventKey: 'coverage.offer.approved',
        payload: {
          kind: 'offer',
          entity_id: 'offer-1',
          reference: 'COV-1',
          service_id: 'service-1',
          amount: '1000',
          currency: 'SAR',
          attributes: {
            coverage_scope: 'domestic',
            coverage_country: null,
            pay_region_id: 'south-1',
            pay_method: 'cash',
            receive_region_id: 'north-1',
            receive_method: 'networks',
          },
          commission_amount: '7',
          commission_currency: 'SAR',
        },
      }),
    ).resolves.toBe('rendered coverage')

    expect(mocks.renderCoverageApprovedCustomerMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc-1',
        kind: 'offer',
        payRegion: 'عدن',
        receiveRegion: 'صنعاء',
        amount: '1000',
        currency: 'SAR',
      }),
    )
  })
})
