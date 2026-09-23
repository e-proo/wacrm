import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../../../../supabase/migrations/102_intents_native_business_events.sql', import.meta.url),
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

  it('emits canonical service_request events from the authoritative status update', () => {
    expect(migration).toContain('enqueue_service_intent_business_event_shadow')
    expect(migration).toContain("after update of status on public.customer_intents")
    expect(migration).toContain("when 'fulfilled' then 'service_request.approved'")
    expect(migration).toContain("when 'rejected' then 'service_request.rejected'")
    expect(migration).toContain("when 'matched' then 'service_request.matched'")
    expect(migration).toContain(
      "when 'clarifying' then 'service_request.needs_clarification'",
    )
  })

  it('keeps the event in shadow while preserving the legacy dedupe attachment path', () => {
    expect(migration).toContain("'shadow'")
    expect(migration).toContain(
      "v_event_type || ':v1:service_intent:' || new.id::text",
    )
    expect(migration).toContain('legacy_notification_id')
    expect(migration).toContain('on conflict (account_id, dedupe_key) do update')
  })

  it('uses a security-invoker trigger function with a controlled search path', () => {
    expect(migration).toContain('security invoker')
    expect(migration).toContain('set search_path = pg_catalog, public, extensions')
    expect(migration).toContain(
      'revoke execute on function public.enqueue_service_intent_business_event_shadow()',
    )
  })
})
