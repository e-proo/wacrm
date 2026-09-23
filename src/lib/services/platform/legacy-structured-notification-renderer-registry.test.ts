import { describe, expect, it } from 'vitest'
import { LegacyStructuredNotificationRendererRegistry } from './legacy-structured-notification-renderer-registry'

const input = {
  accountId: 'acc-1',
  eventKey: 'coverage.offer.approved',
  payload: { amount: '1000', currency: 'SAR' },
}

describe('legacy structured notification renderer registry', () => {
  it('returns null when no transitional adapter owns the event', async () => {
    const registry = new LegacyStructuredNotificationRendererRegistry()
    await expect(registry.render(input)).resolves.toBeNull()
  })

  it('returns the single renderer result and ignores null adapters', async () => {
    const registry = new LegacyStructuredNotificationRendererRegistry()
      .register({
        key: 'declines',
        render: async () => null,
      })
      .register({
        key: 'owns',
        render: async () => 'rendered',
      })

    await expect(registry.render(input)).resolves.toBe('rendered')
  })

  it('fails closed when multiple legacy adapters claim the same event', async () => {
    const registry = new LegacyStructuredNotificationRendererRegistry()
      .register({ key: 'a', render: async () => 'a' })
      .register({ key: 'b', render: async () => 'b' })

    await expect(registry.render(input)).rejects.toThrow(
      'Ambiguous legacy structured notification renderer',
    )
  })
})
