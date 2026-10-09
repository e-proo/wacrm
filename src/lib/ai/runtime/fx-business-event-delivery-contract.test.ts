import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fxOutcomeForBusinessEvent } from '@/lib/messaging/fx-v2-outbox'

const deliverySource = readFileSync(
  new URL('./customer-notification-delivery.ts', import.meta.url),
  'utf8',
)
const unifiedClaimMigrationSource = readFileSync(
  new URL('../../../../supabase/migrations/088_unified_customer_business_event_claim.sql', import.meta.url),
  'utf8',
)
const canonicalEventMigrationSource = readFileSync(
  new URL('../../../../supabase/migrations/089_fx_trade_canonical_business_events.sql', import.meta.url),
  'utf8',
)

describe('FX V2 unified customer business-event delivery', () => {
  it('claims service and FX events through the unified outbox RPC', () => {
    expect(deliverySource).toContain("db.rpc('claim_customer_business_notifications'")
    expect(deliverySource).not.toContain("db.rpc('claim_customer_intent_notifications'")
    expect(unifiedClaimMigrationSource).toContain('fx_trade_request_id uuid')
    expect(unifiedClaimMigrationSource).toContain('event_type text')
  })

  it('renders FX rows from authoritative trade state before WhatsApp transport', () => {
    expect(deliverySource).toContain('renderFxTradeBusinessEventText')
    expect(deliverySource).toContain('row.fx_trade_request_id')
    expect(deliverySource).toContain('eventType: input.row.event_type')
    expect(deliverySource).toContain('engineSendText({')
  })

  it('maps only the canonical FX trade business-event lifecycle', () => {
    expect(fxOutcomeForBusinessEvent('exchange_rate.trade.requested')).toBe('pending_admin')
    expect(fxOutcomeForBusinessEvent('exchange_rate.trade.approved')).toBe(
      'approved_for_contact',
    )
    expect(fxOutcomeForBusinessEvent('exchange_rate.trade.rejected')).toBe('rejected')
    expect(fxOutcomeForBusinessEvent('exchange_rate.trade.completed')).toBe('completed')

    expect(fxOutcomeForBusinessEvent('exchange_rate.trade.pending')).toBeNull()
    expect(fxOutcomeForBusinessEvent('exchange_rate.trade.approved_for_contact')).toBeNull()
  })

  it('emits canonical requested and approved events from internal workflow statuses', () => {
    expect(canonicalEventMigrationSource).toContain(
      "when 'pending_admin' then 'exchange_rate.trade.requested'",
    )
    expect(canonicalEventMigrationSource).toContain(
      "when 'approved_for_contact' then 'exchange_rate.trade.approved'",
    )
    expect(canonicalEventMigrationSource).not.toContain(
      "then 'exchange_rate.trade.approved_for_contact'",
    )
  })
})
