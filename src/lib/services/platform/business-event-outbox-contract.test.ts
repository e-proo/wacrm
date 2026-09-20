import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../../../../supabase/migrations/090_general_business_outbox.sql', import.meta.url),
  'utf8',
)
const grantHardening = readFileSync(
  new URL('../../../../supabase/migrations/091_business_event_outbox_grant_hardening.sql', import.meta.url),
  'utf8',
)
const advisorCleanup = readFileSync(
  new URL('../../../../supabase/migrations/092_business_event_outbox_advisor_cleanup.sql', import.meta.url),
  'utf8',
)
const coverageSnapshotLabels = readFileSync(
  new URL('../../../../supabase/migrations/093_coverage_business_event_snapshot_labels.sql', import.meta.url),
  'utf8',
)
const shadowEvidence = readFileSync(
  new URL('../../../../supabase/migrations/094_business_event_shadow_projection_evidence.sql', import.meta.url),
  'utf8',
)
const serviceRequestSnapshots = readFileSync(
  new URL('../../../../supabase/migrations/095_service_request_business_event_snapshots.sql', import.meta.url),
  'utf8',
)
const shadowRecheck = readFileSync(
  new URL('../../../../supabase/migrations/096_business_event_shadow_recheck.sql', import.meta.url),
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
    expect(grantHardening).toContain(
      'from public, anon, authenticated, service_role',
    )
    expect(grantHardening).toContain(
      'grant select, insert, update, delete',
    )
    expect(grantHardening).not.toContain('grant truncate')
    expect(advisorCleanup).toContain('business_event_outbox_contact_idx')
    expect(advisorCleanup).toContain('business_event_outbox_conversation_idx')
    expect(advisorCleanup).toContain('business_event_outbox_local_message_idx')
    expect(advisorCleanup).toContain('to service_role')
    expect(migration).toContain('alter table public.business_event_outbox enable row level security')
  })
})


describe('Phase F Coverage event snapshot projection prerequisites', () => {
  it('freezes Coverage region labels in future embedded-event snapshots', () => {
    expect(coverageSnapshotLabels).toContain("'pay_region_label', v_pay_region_label")
    expect(coverageSnapshotLabels).toContain(
      "'receive_region_label', v_receive_region_label",
    )
    expect(coverageSnapshotLabels).toContain('from public.coverage_regions as cr')
    expect(coverageSnapshotLabels).not.toContain('update public.business_event_outbox')
  })

  it('keeps the new shadow rendering path transport-free', () => {
    const shadowRuntime = readFileSync(
      new URL('./business-event-outbox.ts', import.meta.url),
      'utf8',
    )
    expect(shadowRuntime).toContain('inspectShadowBusinessEventRendering')
    expect(shadowRuntime).toContain('CURRENT_EVENT_PROJECTOR_REGISTRY')
    expect(shadowRuntime).not.toContain('engineSendText')
  })
})


describe('Phase G shadow cutover evidence', () => {
  it('persists cutover evidence without promoting any row to active delivery', () => {
    expect(shadowEvidence).toContain('shadow_projection_status')
    expect(shadowEvidence).toContain("'matched_legacy'")
    expect(shadowEvidence).toContain("'mismatched_legacy'")
    expect(shadowEvidence).toContain('shadow_render_hash')
    expect(shadowEvidence).toContain('shadow_legacy_hash')
    expect(shadowEvidence).toContain("shadow_projection_status = 'checking'")
    expect(shadowEvidence).not.toContain("set delivery_mode = 'active'")
  })

  it('reclaims stale shadow checks without changing the RPC return contract', () => {
    expect(shadowEvidence).toContain("interval '15 minutes'")
    expect(shadowEvidence).toContain('for update skip locked')
    expect(shadowEvidence).toContain('shadow_projection_attempts + 1')
    expect(shadowEvidence).toContain('shadow_checked_at timestamptz')
  })

  it('keeps the active delivery worker on the legacy claim until an explicit cutover', () => {
    expect(activeDelivery).toContain("db.rpc('claim_customer_business_notifications'")
    expect(activeDelivery).not.toContain("db.rpc('claim_business_event_outbox'")
  })
})


describe('generic service-request shadow preparation', () => {
  it('stores self-contained generic service request facts at event creation time', () => {
    expect(serviceRequestSnapshots).toContain("'service_id', v_service_id")
    expect(serviceRequestSnapshots).toContain("'service_name', v_service_name")
    expect(serviceRequestSnapshots).toContain("'customer_reason', v_customer_reason")
    expect(serviceRequestSnapshots).toContain('from public.services as s')
    expect(serviceRequestSnapshots).toContain("beo.event_type like 'service_request.%'")
  })

  it('provides a service-role-only recheck path without activating delivery', () => {
    expect(shadowRecheck).toContain('requeue_business_event_shadow_projection')
    expect(shadowRecheck).toContain("shadow_projection_status = 'pending'")
    expect(shadowRecheck).toContain("delivery_mode = 'shadow'")
    expect(shadowRecheck).toContain('to service_role')
    expect(shadowRecheck).not.toContain("delivery_mode = 'active'")
  })
})
