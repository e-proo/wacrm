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
const fxControlledCutover = readFileSync(
  new URL('../../../../supabase/migrations/097_fx_business_event_controlled_cutover.sql', import.meta.url),
  'utf8',
)
const fxShadowEvidencePreparation = readFileSync(
  new URL('../../../../supabase/migrations/098_fx_shadow_evidence_preparation.sql', import.meta.url),
  'utf8',
)
const genericActiveDelivery = readFileSync(
  new URL('./business-event-delivery.ts', import.meta.url),
  'utf8',
)
const fxReadinessDiagnostics = readFileSync(
  new URL('../../../../supabase/migrations/099_fx_cutover_readiness_diagnostics.sql', import.meta.url),
  'utf8',
)
const shadowStaleRecovery = readFileSync(
  new URL('../../../../supabase/migrations/100_business_event_shadow_stale_recovery.sql', import.meta.url),
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

  it('keeps legacy fallback while adding a generic active delivery path behind explicit routing', () => {
    expect(activeDelivery).toContain('deliverActiveBusinessEventNotifications')
    expect(activeDelivery).toContain("db.rpc('claim_customer_business_notifications'")
    expect(genericActiveDelivery).toContain("db.rpc('claim_business_event_delivery'")
    expect(genericActiveDelivery).toContain('CURRENT_EVENT_PROJECTOR_REGISTRY')
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


describe('controlled FX cutover preparation', () => {
  it('defaults to legacy routing and requires explicit readiness-gated activation', () => {
    expect(fxControlledCutover).toContain("mode text not null default 'legacy'")
    expect(fxControlledCutover).toContain('inspect_fx_business_event_cutover_readiness')
    expect(fxControlledCutover).toContain('FX_BUSINESS_EVENT_CUTOVER_NOT_READY')
    expect(fxControlledCutover).toContain("'matched_legacy'")
    expect(fxControlledCutover).toContain("'required_event_types', 4")
  })

  it('routes only future FX events to active and preserves historical shadow evidence', () => {
    expect(fxControlledCutover).toContain('enqueue_fx_trade_business_event()')
    expect(fxControlledCutover).toContain("v_delivery_mode text := 'shadow'")
    expect(fxControlledCutover).toContain("v_route_mode = 'active'")
    expect(fxControlledCutover).toContain('beo.created_at >= pg_catalog.transaction_timestamp()')
    expect(fxControlledCutover).toContain('Activation changes routing for FUTURE FX events only')
  })

  it('prevents legacy/new FX claim competition and keeps a reversible fallback', () => {
    expect(fxControlledCutover).toContain("c.route_key = 'fx_trade_customer_whatsapp'")
    expect(fxControlledCutover).toContain("c.mode = 'active'")
    expect(fxControlledCutover).toContain('FX_BUSINESS_EVENT_ROLLBACK_IN_FLIGHT')
    expect(fxControlledCutover).toContain("set delivery_mode = 'shadow'")
    expect(fxControlledCutover).toContain('synced_legacy_sent')
  })

  it('keeps the generic active worker free from domain-specific routing branches', () => {
    expect(genericActiveDelivery).not.toContain('exchange_rate')
    expect(genericActiveDelivery).not.toContain('fx_trade_request')
    expect(genericActiveDelivery).not.toContain('coverage')
    expect(genericActiveDelivery).not.toContain('service_intent')
  })
})


describe('real FX shadow evidence preparation', () => {
  it('backfills historical canonical FX notifications into shadow only', () => {
    expect(fxShadowEvidencePreparation).toContain(
      'backfill_fx_business_event_shadow_history',
    )
    expect(fxShadowEvidencePreparation).toContain(
      "'backfilled_from_legacy', true",
    )
    expect(fxShadowEvidencePreparation).toContain("'shadow'")
    expect(fxShadowEvidencePreparation).not.toContain(
      "set delivery_mode = 'active'",
    )
  })

  it('uses a truthful terminal superseded state instead of pretending an old notification was sent', () => {
    expect(fxShadowEvidencePreparation).toContain("'superseded'")
    expect(fxShadowEvidencePreparation).toContain(
      'SUPERSEDED_BY_LATER_FX_EVENT',
    )
    expect(fxShadowEvidencePreparation).toContain(
      "'customer-intent-notification:' || older.id::text",
    )
    expect(fxShadowEvidencePreparation).toContain(
      "newer.status = 'sent'",
    )
  })

  it('supports FX-only shadow claims without consuming another domain queue', () => {
    expect(fxShadowEvidencePreparation).toContain(
      'claim_business_event_outbox_shadow_for_event_types',
    )
    expect(fxShadowEvidencePreparation).toContain(
      'beo.event_type = any(p_event_types)',
    )
    expect(fxShadowEvidencePreparation).toContain('for update skip locked')
    expect(fxShadowEvidencePreparation).toContain('to service_role')
  })
})


describe('FX cutover readiness diagnostics', () => {
  it('reports missing FX evidence without weakening the 4-of-4 readiness gate', () => {
    expect(fxReadinessDiagnostics).toContain("'required_event_types', 4")
    expect(fxReadinessDiagnostics).toContain("'matched_event_type_keys'")
    expect(fxReadinessDiagnostics).toContain("'missing_event_types'")
    expect(fxReadinessDiagnostics).toContain("'pending_event_types'")
    expect(fxReadinessDiagnostics).toContain('v_matched_event_types = 4')
    expect(fxReadinessDiagnostics).toContain('v_blockers = 0')
    expect(fxReadinessDiagnostics).toContain('v_legacy_nonterminal = 0')
    expect(fxReadinessDiagnostics).toContain('v_active_nonterminal = 0')
  })
})


describe('shadow verification stale-claim recovery', () => {
  it('recovers only stale checking rows without touching delivery mode or attempts', () => {
    expect(shadowStaleRecovery).toContain("shadow_projection_status = 'checking'")
    expect(shadowStaleRecovery).toContain("shadow_projection_status = 'pending'")
    expect(shadowStaleRecovery).toContain("delivery_mode = 'shadow'")
    expect(shadowStaleRecovery).toContain('shadow_projection_claimed_at')
    expect(shadowStaleRecovery).toContain('p_stale_after_seconds < 15')
    expect(shadowStaleRecovery).not.toContain('shadow_projection_attempts = 0')
    expect(shadowStaleRecovery).not.toContain("delivery_mode = 'active'")
  })
})
