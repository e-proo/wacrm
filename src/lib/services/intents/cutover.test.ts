import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  INTENTS_BUSINESS_EVENT_ROUTE_KEY,
  INTENTS_CUSTOMER_BUSINESS_EVENT_TYPES,
} from './cutover'

const migration = readFileSync(
  new URL(
    '../../../../supabase/migrations/107_intents_business_event_controlled_cutover.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('Intents controlled Business Event cutover', () => {
  it('uses a dedicated route key and keeps legacy as the default', () => {
    expect(INTENTS_BUSINESS_EVENT_ROUTE_KEY).toBe(
      'service_request_customer_whatsapp',
    )
    expect(migration).toContain("'service_request_customer_whatsapp'")
    expect(migration).toContain("'legacy'")
  })

  it('gates the four authoritative Intents outcomes and excludes completed', () => {
    expect(INTENTS_CUSTOMER_BUSINESS_EVENT_TYPES).toEqual([
      'service_request.approved',
      'service_request.rejected',
      'service_request.matched',
      'service_request.needs_clarification',
    ])
    for (const eventType of INTENTS_CUSTOMER_BUSINESS_EVENT_TYPES) {
      expect(migration).toContain(`'${eventType}'`)
    }
    expect(migration).not.toContain(
      "'service_request.completed',\n      'service_request",
    )
    expect(migration).toContain('v_matched_event_types = 4')
  })

  it('promotes only future change-request-backed events after explicit activation', () => {
    expect(migration).toContain('new.change_request_id is null')
    expect(migration).toContain("c.mode = 'active'")
    expect(migration).toContain("set delivery_mode = 'active'")
    expect(migration).toContain(
      'beo.created_at >= pg_catalog.transaction_timestamp()',
    )
    expect(migration).toContain(
      "beo.correlation_id = new.change_request_id::text",
    )
  })

  it('requires durable parity before activation', () => {
    expect(migration).toContain(
      'inspect_intents_business_event_cutover_readiness',
    )
    expect(migration).toContain("shadow_projection_status = 'matched_legacy'")
    expect(migration).toContain('legacy_notification_id is not null')
    expect(migration).toContain('v_blockers = 0')
    expect(migration).toContain('v_legacy_nonterminal = 0')
    expect(migration).toContain('v_active_nonterminal = 0')
    expect(migration).toContain('INTENTS_BUSINESS_EVENT_CUTOVER_NOT_READY')
  })

  it('keeps rollback reversible and service-role only', () => {
    expect(migration).toContain('INTENTS_BUSINESS_EVENT_ROLLBACK_IN_FLIGHT')
    expect(migration).toContain("set delivery_mode = 'shadow'")
    expect(migration).toContain('synced_legacy_sent')
    expect(migration).toContain(
      'revoke execute on function public.inspect_intents_business_event_cutover_readiness(uuid)',
    )
    expect(migration).toContain(
      'grant execute on function public.inspect_intents_business_event_cutover_readiness(uuid)',
    )
    expect(migration).toContain(
      'grant execute on function public.set_intents_business_event_delivery_mode(uuid, text)',
    )
  })
})


const ownershipMigration = readFileSync(
  new URL(
    '../../../../supabase/migrations/108_intents_business_event_ownership_scope.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('Intents Business Event ownership hardening', () => {
  it('requires exact Intents action ownership before active routing', () => {
    expect(ownershipMigration).toContain(
      "cr.action_key = 'intents.decision.apply' and cr.action_version = 1",
    )
    expect(ownershipMigration).toContain(
      "cr.action_key is null and cr.target_type = 'service_intent'",
    )
    expect(ownershipMigration).toContain('if not v_owned then')
  })

  it('quarantines historical cross-domain service-request events without deleting them', () => {
    expect(ownershipMigration).toContain(
      "shadow_projection_status = 'native_only'",
    )
    expect(ownershipMigration).toContain(
      "'INTENTS_EVENT_OWNERSHIP_MISMATCH'",
    )
    expect(ownershipMigration).not.toContain(
      'delete from public.business_event_outbox',
    )
  })

  it('scopes readiness blockers and rollback work to Intents-owned change requests', () => {
    expect(ownershipMigration).toContain(
      'create or replace function public.inspect_intents_business_event_cutover_readiness',
    )
    expect(ownershipMigration).toContain(
      'create or replace function public.set_intents_business_event_delivery_mode',
    )
    expect(ownershipMigration).toContain(
      "cr.action_key = 'intents.decision.apply'",
    )
  })
})
