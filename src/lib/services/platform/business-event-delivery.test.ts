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

  it('uses canonical projectors for linked legacy rollback rows without domain adapters', () => {
    const delivery = readFileSync(
      new URL('./business-event-delivery.ts', import.meta.url),
      'utf8',
    )
    const runtime = readFileSync(
      new URL('../../ai/runtime/customer-notification-delivery.ts', import.meta.url),
      'utf8',
    )

    expect(delivery).toContain('renderLinkedLegacyBusinessEventNotification')
    expect(delivery).toContain('CURRENT_EVENT_PROJECTOR_REGISTRY')
    expect(runtime).toContain('renderLinkedLegacyBusinessEventNotification')
    expect(runtime).not.toContain('CURRENT_LEGACY_NOTIFICATION_RENDERERS')
    expect(runtime).toContain('LEGACY_NOTIFICATION_CANONICAL_EVENT_MISSING')
    expect(runtime).not.toContain('renderFxTradeBusinessEventText')
    expect(runtime).not.toContain('renderServiceRequestCustomerMessage')
  })

  it('lets the AI runtime flush only business events correlated to the current run', () => {
    const dispatch = readFileSync(
      new URL('../../ai/runtime/dispatch.ts', import.meta.url),
      'utf8',
    )
    expect(dispatch).toContain('deliverActiveBusinessEventNotifications')
    expect(dispatch).toContain('correlationId: runId')
    expect(dispatch).toContain('correlated business events claimed=')
  })

  it('treats a sent correlated business event as the single customer reply', () => {
    const delivery = readFileSync(
      new URL('./business-event-delivery.ts', import.meta.url),
      'utf8',
    )
    const dispatch = readFileSync(
      new URL('../../ai/runtime/dispatch.ts', import.meta.url),
      'utf8',
    )

    expect(delivery).toContain('lastLocalMessageId: string | null')
    expect(delivery).toContain('lastLocalMessageId = delivered.local_message_id')
    expect(dispatch).toContain('correlatedBusinessEventMessageId')
    expect(dispatch).toContain('outbound_message_id: correlatedBusinessEventMessageId')
    expect(dispatch).toContain('suppressing model reply')
  })
})
