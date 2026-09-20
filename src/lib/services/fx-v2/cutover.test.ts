import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  FX_BUSINESS_EVENT_ROUTE_KEY,
  FX_BUSINESS_EVENT_TYPES,
} from './cutover'

describe('FX controlled business-event cutover contract', () => {
  it('uses one explicit account-scoped route key', () => {
    expect(FX_BUSINESS_EVENT_ROUTE_KEY).toBe('fx_trade_customer_whatsapp')
  })

  it('covers the complete canonical customer trade lifecycle', () => {
    expect(FX_BUSINESS_EVENT_TYPES).toEqual([
      'exchange_rate.trade.requested',
      'exchange_rate.trade.approved',
      'exchange_rate.trade.rejected',
      'exchange_rate.trade.completed',
    ])
  })

  it('preparation remains scoped to canonical FX event types', () => {
    const source = readFileSync(new URL('./cutover.ts', import.meta.url), 'utf8')
    expect(source).toContain('prepareFxBusinessEventShadowVerification')
    expect(source).toContain('eventTypes: FX_BUSINESS_EVENT_TYPES')
    expect(source).toContain('backfillFxBusinessEventShadowHistory')
    expect(source).toContain('reconcileSupersededFxLegacyNotifications')
  })
})


describe('FX readiness diagnostics', () => {
  it('exposes missing/pending event diagnostics in the public readiness contract', () => {
    const source = readFileSync(new URL('./cutover.ts', import.meta.url), 'utf8')
    expect(source).toContain('matchedEventTypeKeys')
    expect(source).toContain('missingEventTypes')
    expect(source).toContain('pendingEventTypes')
    expect(source).toContain('matched_event_type_keys')
    expect(source).toContain('missing_event_types')
    expect(source).toContain('pending_event_types')
  })
})
