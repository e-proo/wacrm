import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const initialMigration = readFileSync(
  new URL('../../../../supabase/migrations/102_intents_native_business_events.sql', import.meta.url),
  'utf8',
)
const ownershipMigration = readFileSync(
  new URL('../../../../supabase/migrations/108_intents_business_event_ownership_scope.sql', import.meta.url),
  'utf8',
)
const executor = readFileSync(
  new URL('./change-executors.ts', import.meta.url),
  'utf8',
)

describe('Intents native Business Event producer', () => {
  it('binds the authoritative intent mutation to its decision change request', () => {
    expect(executor).toContain('change_request_id: context.changeRequestId')
  })

  it('keeps the original atomic trigger boundary and hardens final ownership', () => {
    expect(initialMigration).toContain('enqueue_service_intent_business_event_shadow')
    expect(initialMigration).toContain('after update of status on public.customer_intents')
    expect(ownershipMigration).toContain(
      "v_action_key = 'intents.decision.apply' and v_action_version = 1",
    )
    expect(ownershipMigration).toContain(
      "v_action_key is null and v_target_type = 'service_intent'",
    )
  })

  it('emits the four current authoritative service-request outcomes', () => {
    expect(ownershipMigration).toContain("when 'fulfilled' then 'service_request.approved'")
    expect(ownershipMigration).toContain("when 'rejected' then 'service_request.rejected'")
    expect(ownershipMigration).toContain("when 'matched' then 'service_request.matched'")
    expect(ownershipMigration).toContain(
      "when 'clarifying' then 'service_request.needs_clarification'",
    )
  })

  it('preserves shadow mode and the legacy dedupe attachment path', () => {
    expect(ownershipMigration).toContain("'shadow'")
    expect(ownershipMigration).toContain(
      "v_event_type || ':v1:service_intent:' || new.id::text",
    )
    expect(ownershipMigration).toContain('legacy_notification_id')
    expect(ownershipMigration).toContain(
      'on conflict (account_id, dedupe_key) do update',
    )
  })

  it('uses a security-invoker trigger function with a controlled search path', () => {
    expect(ownershipMigration).toContain('security invoker')
    expect(ownershipMigration).toContain(
      'set search_path = pg_catalog, public, extensions',
    )
    expect(ownershipMigration).toContain(
      'revoke execute on function public.enqueue_service_intent_business_event_shadow()',
    )
  })
})
