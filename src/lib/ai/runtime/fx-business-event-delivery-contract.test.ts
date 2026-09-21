import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fxOutcomeForBusinessEvent } from '@/lib/messaging/fx-v2-outbox'

const deliverySource = readFileSync(
  new URL('./customer-notification-delivery.ts', import.meta.url),
  'utf8',
)
const workerSource = readFileSync(
  new URL('./worker.ts', import.meta.url),
  'utf8',
)
const businessNotificationsSource = readFileSync(
  new URL('./business-notifications.ts', import.meta.url),
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


describe('background notification worker cutover safety', () => {
  it('delegates all claiming and sending to the route-aware unified delivery boundary', () => {
    expect(workerSource).toContain('deliverCustomerOutcomeNotifications')
    expect(workerSource).toContain("from('business_event_outbox')")
    expect(workerSource).toContain("from('customer_intent_notifications')")
    expect(workerSource).not.toContain("status: 'sending'")
    expect(workerSource).not.toContain('engineSendText({')
    expect(workerSource).not.toContain('renderFxTradeCustomerMessage')
    expect(workerSource).not.toContain('randomUUID')
  })

  it('shares one batch budget between active and legacy claims', () => {
    expect(deliverySource).toContain('const remaining = limit - activeDelivery.claimed')
    expect(deliverySource).toContain('p_limit: remaining')
  })
})


describe('legacy sender contraction', () => {
  it('removes the superseded direct customer sender from business-notifications', () => {
    expect(businessNotificationsSource).not.toContain(
      'deliverPendingCustomerIntentNotifications',
    )
    expect(businessNotificationsSource).not.toContain(
      ".from('customer_intent_notifications')",
    )
    expect(businessNotificationsSource).not.toContain('engineSendText({')
  })
})
