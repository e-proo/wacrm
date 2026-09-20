import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { businessEventEngineIdempotencyKey } from './business-event-delivery'

describe('generic active business-event delivery', () => {
  it('preserves the legacy transport idempotency key across cutover', () => {
    expect(
      businessEventEngineIdempotencyKey({
        eventId: 'event-1',
        legacyNotificationId: 'legacy-1',
      }),
    ).toBe('customer-intent-notification:legacy-1')
  })

  it('uses the general outbox event id when no legacy link exists', () => {
    expect(
      businessEventEngineIdempotencyKey({
        eventId: 'event-2',
        legacyNotificationId: null,
      }),
    ).toBe('business-event-outbox:event-2')
  })

  it('has no domain-specific delivery switch', () => {
    const source = readFileSync(new URL('./business-event-delivery.ts', import.meta.url), 'utf8')
    expect(source).toContain('CURRENT_EVENT_PROJECTOR_REGISTRY')
    expect(source).toContain('renderBusinessEventProjection')
    expect(source).not.toContain('exchange_rate')
    expect(source).not.toContain('fx_trade_request')
    expect(source).not.toContain('coverage')
    expect(source).not.toContain('service_intent')
  })
})
