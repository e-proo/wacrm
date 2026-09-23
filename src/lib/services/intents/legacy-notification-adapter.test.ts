import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(),
  renderServiceRequestCustomerMessage: vi.fn(),
  createSupabaseTemplateOverrideStore: vi.fn(() => ({ store: true })),
  changeMaybeSingle: vi.fn(),
  serviceMaybeSingle: vi.fn(),
}))

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}))

vi.mock('@/lib/messaging/service-request-customer', () => ({
  renderServiceRequestCustomerMessage:
    mocks.renderServiceRequestCustomerMessage,
}))

vi.mock('@/lib/messaging/supabase-store', () => ({
  createSupabaseTemplateOverrideStore:
    mocks.createSupabaseTemplateOverrideStore,
}))

import { INTENTS_LEGACY_NOTIFICATION_RENDERER } from './legacy-notification-adapter'

function installDb() {
  const changeQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: mocks.changeMaybeSingle,
  }
  changeQuery.select.mockReturnValue(changeQuery)
  changeQuery.eq.mockReturnValue(changeQuery)

  const serviceQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: mocks.serviceMaybeSingle,
  }
  serviceQuery.select.mockReturnValue(serviceQuery)
  serviceQuery.eq.mockReturnValue(serviceQuery)

  const db = {
    from: vi.fn((table: string) =>
      table === 'change_requests' ? changeQuery : serviceQuery,
    ),
  }
  mocks.supabaseAdmin.mockReturnValue(db)
  return db
}

describe('Intents legacy customer notification adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installDb()
  })

  it('declines rows without intent/change-request linkage', async () => {
    await expect(
      INTENTS_LEGACY_NOTIFICATION_RENDERER.render({
        accountId: 'acc-1',
        notification: {
          id: 'notification-1',
          intentId: null,
          changeRequestId: null,
          eventType: 'approved_and_applied',
        },
      }),
    ).resolves.toBeNull()

    expect(mocks.changeMaybeSingle).not.toHaveBeenCalled()
    expect(mocks.renderServiceRequestCustomerMessage).not.toHaveBeenCalled()
  })

  it('declines linked notifications owned by another change target', async () => {
    mocks.changeMaybeSingle.mockResolvedValue({
      data: {
        target_type: 'coverage_offer',
        target_id: 'offer-1',
        proposed_payload: {},
        execution_result: {},
      },
      error: null,
    })

    await expect(
      INTENTS_LEGACY_NOTIFICATION_RENDERER.render({
        accountId: 'acc-1',
        notification: {
          id: 'notification-1',
          intentId: 'intent-1',
          changeRequestId: 'change-1',
          eventType: 'approved_and_applied',
        },
      }),
    ).resolves.toBeNull()

    expect(mocks.renderServiceRequestCustomerMessage).not.toHaveBeenCalled()
  })

  it('renders a matched service-intent outcome from authoritative change state', async () => {
    mocks.changeMaybeSingle.mockResolvedValue({
      data: {
        target_type: 'service_intent',
        target_id: 'intent-1',
        proposed_payload: {
          decision: 'matched',
          matched_service_id: 'service-1',
          customer_reason: 'matched by admin',
        },
        execution_result: {
          decision: 'matched',
        },
      },
      error: null,
    })
    mocks.serviceMaybeSingle.mockResolvedValue({
      data: { name: 'تحويلات' },
      error: null,
    })
    mocks.renderServiceRequestCustomerMessage.mockResolvedValue({
      text: 'rendered intent',
      source: 'system',
      eventKey: 'service_request.matched',
      resolvedLocale: 'ar',
    })

    await expect(
      INTENTS_LEGACY_NOTIFICATION_RENDERER.render({
        accountId: 'acc-1',
        notification: {
          id: 'notification-1',
          intentId: 'intent-1',
          changeRequestId: 'change-1',
          eventType: 'matched',
        },
      }),
    ).resolves.toBe('rendered intent')

    expect(mocks.renderServiceRequestCustomerMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc-1',
        outcome: 'matched',
        entityId: 'intent-1',
        serviceId: 'service-1',
        serviceName: 'تحويلات',
        customerReason: 'matched by admin',
      }),
    )
  })
})
