import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  COVERAGE_BUSINESS_EVENT_ROUTE_KEY,
  COVERAGE_CUSTOMER_BUSINESS_EVENT_TYPES,
} from './cutover'

const migration = readFileSync(
  new URL(
    '../../../../supabase/migrations/106_coverage_business_event_controlled_cutover.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('Coverage controlled Business Event cutover', () => {
  it('keeps Coverage on legacy by default and gates activation on durable parity', () => {
    expect(COVERAGE_BUSINESS_EVENT_ROUTE_KEY).toBe(
      'coverage_customer_whatsapp',
    )
    expect(COVERAGE_CUSTOMER_BUSINESS_EVENT_TYPES).toEqual([
      'coverage.offer.approved',
      'coverage.request.approved',
    ])
    expect(migration).toContain(
      'inspect_coverage_business_event_cutover_readiness',
    )
    expect(migration).toContain(
      'COVERAGE_BUSINESS_EVENT_CUTOVER_NOT_READY',
    )
    expect(migration).toContain("'required_event_types', 2")
    expect(migration).toContain("'matched_legacy'")
  })

  it('routes only future approved Coverage events after explicit activation', () => {
    expect(migration).toContain('route_coverage_customer_business_event')
    expect(migration).toContain(
      "c.route_key = 'coverage_customer_whatsapp'",
    )
    expect(migration).toContain("c.mode = 'active'")
    expect(migration).toContain(
      'coverage_offers_business_event_zz_route',
    )
    expect(migration).toContain(
      'coverage_requests_business_event_zz_route',
    )
    expect(migration).not.toContain(
      "update public.business_event_outbox set delivery_mode = 'active'",
    )
  })

  it('replaces FX-specific legacy arbitration with canonical-link arbitration', () => {
    expect(migration).toContain(
      'beo.legacy_notification_id = cin.id',
    )
    expect(migration).toContain("beo.delivery_mode = 'active'")
    expect(migration).not.toContain(
      "c.route_key = 'fx_trade_customer_whatsapp'",
    )
    expect(migration).not.toContain(
      'cin.fx_trade_request_id is not null',
    )
  })

  it('syncs late legacy rows if the canonical active event already sent', () => {
    expect(migration).toContain(
      'sync_linked_active_business_event_legacy_sent',
    )
    expect(migration).toContain(
      'zz_customer_intent_notifications_business_event_sent_sync',
    )
    expect(migration).toContain("beo.status = 'sent'")
  })

  it('keeps rollback reversible and service-role only', () => {
    expect(migration).toContain(
      'COVERAGE_BUSINESS_EVENT_ROLLBACK_IN_FLIGHT',
    )
    expect(migration).toContain("set delivery_mode = 'shadow'")
    expect(migration).toContain('synced_legacy_sent')
    expect(migration).toContain(
      'grant execute on function public.set_coverage_business_event_delivery_mode(uuid, text)',
    )
    expect(migration).toContain('to service_role')
  })
})
