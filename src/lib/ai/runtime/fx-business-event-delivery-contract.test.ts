import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fxOutcomeForBusinessEvent } from '@/lib/messaging/fx-v2-outbox'

const deliverySource = readFileSync(
  new URL('./customer-notification-delivery.ts', import.meta.url),
  'utf8',
)
const migrationSource = readFileSync(
  new URL('../../../../supabase/migrations/088_unified_customer_business_event_claim.sql', import.meta.url),
  'utf8',
)

describe('FX V2 unified customer business-event delivery', () => {
  it('claims service and FX events through the unified outbox RPC', () => {
    expect(deliverySource).toContain("db.rpc('claim_customer_business_notifications'")
    expect(deliverySource).not.toContain("db.rpc('claim_customer_intent_notifications'")
    expect(migrationSource).toContain('fx_trade_request_id uuid')
    expect(migrationSource).toContain('event_type text')
  })

  it('renders FX rows from authoritative trade state before transport', () => {
    expect(deliverySource).toContain('renderFxTradeBusinessEventText')
    expect(deliverySource).toContain('row.fx_trade_request_id')
    expect(deliverySource).toContain('eventType: input.row.event_type')
  })

  it('supports both the current lifecycle event and the canonical approved alias', () => {
    expect(fxOutcomeForBusinessEvent('exchange_rate.trade.approved_for_contact')).toBe(
      'approved_for_contact',
    )
    expect(fxOutcomeForBusinessEvent('exchange_rate.trade.approved')).toBe(
      'approved_for_contact',
    )
  })
})
