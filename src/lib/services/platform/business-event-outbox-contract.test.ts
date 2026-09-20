import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../../../../supabase/migrations/090_general_business_outbox.sql', import.meta.url),
  'utf8',
)
const activeDelivery = readFileSync(
  new URL('../../ai/runtime/customer-notification-delivery.ts', import.meta.url),
  'utf8',
)

describe('Phase E general business outbox contract', () => {
  it('creates a domain-neutral versioned outbox with deterministic dedupe identity', () => {
    expect(migration).toContain('create table if not exists public.business_event_outbox')
    expect(migration).toContain('event_version integer not null default 1')
    expect(migration).toContain('subject_type text not null')
    expect(migration).toContain('subject_id text not null')
    expect(migration).toContain('dedupe_key text not null')
    expect(migration).toContain('business_event_outbox_account_dedupe_uidx')
  })

  it('starts every new producer in shadow mode and leaves the legacy sender active', () => {
    expect(migration).toContain("delivery_mode text not null default 'shadow'")
    expect(migration).toContain("delivery_mode in ('shadow', 'active')")
    expect(migration).toContain("delivery_mode = 'shadow'")
    expect(activeDelivery).toContain("db.rpc('claim_customer_business_notifications'")
    expect(activeDelivery).not.toContain("db.rpc('claim_business_event_outbox'")
  })

  it('supports non-sending shadow claims and a future active SKIP LOCKED claim', () => {
    expect(migration).toContain('claim_business_event_outbox_shadow')
    expect(migration).toContain('shadow_checked_at is null')
    expect(migration).toContain('for update skip locked')
    expect(migration).toContain('claim_business_event_outbox(')
    expect(migration).toContain("delivery_mode = 'active'")
  })

  it('mirrors legacy rows and uses native producer dedupe keys to avoid duplicate events', () => {
    expect(migration).toContain('mirror_legacy_customer_notification_to_business_outbox')
    expect(migration).toContain('legacy_notification_id')
    expect(migration).toContain('on conflict (account_id, dedupe_key) do update')
    expect(migration).toContain("'coverage.offer.approved'")
    expect(migration).toContain("'coverage.request.approved'")
    expect(migration).toContain("'exchange_rate.trade.requested'")
  })

  it('writes current FX and Coverage lifecycle events atomically from database triggers', () => {
    expect(migration).toContain('exchange_trade_requests_business_event_shadow')
    expect(migration).toContain('coverage_offers_business_event_shadow')
    expect(migration).toContain('coverage_requests_business_event_shadow')
    expect(migration).toContain('coverage_matches_business_event_shadow')
    expect(migration).toContain("'coverage.match.reserved'")
    expect(migration).toContain("'coverage.match.released'")
    expect(migration).not.toContain("'coverage.match.confirmed'")
    expect(migration).not.toContain("'coverage.match.fulfilled'")
  })

  it('keeps the outbox private and explicitly grants only service-role table access', () => {
    expect(migration).toContain(
      'revoke all on table public.business_event_outbox from public, anon, authenticated',
    )
    expect(migration).toContain(
      'grant select, insert, update, delete on table public.business_event_outbox to service_role',
    )
    expect(migration).toContain('alter table public.business_event_outbox enable row level security')
  })
})
