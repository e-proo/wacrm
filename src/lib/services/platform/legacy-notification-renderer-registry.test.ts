import { describe, expect, it } from 'vitest'
import { LegacyCustomerNotificationRendererRegistry } from './legacy-notification-renderer-registry'

describe('legacy customer notification renderer registry', () => {
  it('returns null when no temporary rollback adapter owns the row', async () => {
    const registry = new LegacyCustomerNotificationRendererRegistry()
    await expect(
      registry.render({
        accountId: 'acc-1',
        notification: {
          id: 'n-1',
          intentId: 'intent-1',
          fxTradeRequestId: null,
          eventType: 'service_request.approved',
        },
      }),
    ).resolves.toBeNull()
  })

  it('dispatches exactly one matching domain adapter', async () => {
    const registry = new LegacyCustomerNotificationRendererRegistry().register({
      key: 'testing.legacy',
      matches: (notification) => Boolean(notification.fxTradeRequestId),
      render: async ({ notification }) => 'rendered:' + notification.eventType,
    })

    await expect(
      registry.render({
        accountId: 'acc-1',
        notification: {
          id: 'n-1',
          intentId: null,
          fxTradeRequestId: 'fx-1',
          eventType: 'exchange_rate.trade.approved',
        },
      }),
    ).resolves.toBe('rendered:exchange_rate.trade.approved')
  })

  it('fails closed on ambiguous temporary adapters', async () => {
    const registry = new LegacyCustomerNotificationRendererRegistry()
      .register({
        key: 'a',
        matches: () => true,
        render: async () => 'a',
      })
      .register({
        key: 'b',
        matches: () => true,
        render: async () => 'b',
      })

    await expect(
      registry.render({
        accountId: 'acc-1',
        notification: {
          id: 'n-1',
          intentId: null,
          fxTradeRequestId: 'fx-1',
          eventType: 'exchange_rate.trade.approved',
        },
      }),
    ).rejects.toThrow('Ambiguous legacy notification renderer')
  })
})
