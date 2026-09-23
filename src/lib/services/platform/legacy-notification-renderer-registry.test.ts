import { describe, expect, it } from 'vitest'
import { LegacyCustomerNotificationRendererRegistry } from './legacy-notification-renderer-registry'

const input = {
  accountId: 'acc-1',
  notification: {
    id: 'n-1',
    intentId: null,
    changeRequestId: null,
    eventType: 'exchange_rate.trade.approved',
  },
}

describe('legacy customer notification renderer registry', () => {
  it('returns null when no temporary rollback adapter owns the row', async () => {
    const registry = new LegacyCustomerNotificationRendererRegistry()
    await expect(registry.render(input)).resolves.toBeNull()
  })

  it('dispatches exactly one domain adapter that returns rendered text', async () => {
    const registry = new LegacyCustomerNotificationRendererRegistry().register({
      key: 'testing.legacy',
      render: async ({ notification }) =>
        'rendered:' + notification.eventType,
    })

    await expect(registry.render(input)).resolves.toBe(
      'rendered:exchange_rate.trade.approved',
    )
  })

  it('ignores adapters that decline ownership with null', async () => {
    const registry = new LegacyCustomerNotificationRendererRegistry()
      .register({
        key: 'declines',
        render: async () => null,
      })
      .register({
        key: 'owns',
        render: async () => 'owned',
      })

    await expect(registry.render(input)).resolves.toBe('owned')
  })

  it('fails closed on ambiguous temporary adapters', async () => {
    const registry = new LegacyCustomerNotificationRendererRegistry()
      .register({
        key: 'a',
        render: async () => 'a',
      })
      .register({
        key: 'b',
        render: async () => 'b',
      })

    await expect(registry.render(input)).rejects.toThrow(
      'Ambiguous legacy notification renderer',
    )
  })
})
