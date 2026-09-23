import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL(
    '../../../../supabase/migrations/105_subject_scoped_business_event_claim.sql',
    import.meta.url,
  ),
  'utf8',
)
const delivery = readFileSync(
  new URL('./business-event-delivery.ts', import.meta.url),
  'utf8',
)
const customerDelivery = readFileSync(
  new URL('../../ai/runtime/customer-notification-delivery.ts', import.meta.url),
  'utf8',
)

describe('subject-scoped active Business Event delivery', () => {
  it('adds an additive claim RPC without replacing the worker-wide legacy signature', () => {
    expect(migration).toContain(
      'create or replace function public.claim_business_event_delivery_v2(',
    )
    expect(migration).toContain('p_subject_type text default null')
    expect(migration).toContain('p_subject_id text default null')
    expect(migration).toContain('beo.subject_type = p_subject_type')
    expect(migration).toContain('beo.subject_id = p_subject_id')
  })

  it('preserves correlation ordering inside the selected subject', () => {
    expect(migration).toContain('with correlated_subjects as (')
    expect(migration).toContain(
      'and beo.created_at <= cs.correlated_created_at',
    )
    expect(migration).toContain(
      'order by beo.created_at asc, beo.id asc',
    )
  })

  it('keeps the scoped claim service-role only', () => {
    expect(migration).toContain(
      'revoke execute on function public.claim_business_event_delivery_v2(',
    )
    expect(migration).toContain('from public, anon, authenticated')
    expect(migration).toContain('to service_role')
  })

  it('passes generic subject filters through the platform delivery boundary', () => {
    expect(delivery).toContain("db.rpc('claim_business_event_delivery_v2'")
    expect(delivery).toContain('p_subject_type: input.subjectType ?? null')
    expect(delivery).toContain('p_subject_id: input.subjectId ?? null')
    expect(delivery).toContain('BUSINESS_EVENT_SUBJECT_FILTER_INCOMPLETE')
    expect(delivery).not.toContain('fx_trade_request')
  })

  it('loads transport ownership outside the domain and exposes a generic subject helper', () => {
    expect(customerDelivery).toContain(
      'deliverActiveSubjectBusinessEventNotifications',
    )
    expect(customerDelivery).toContain('loadWhatsAppDeliveryOwner')
    expect(customerDelivery).not.toContain('fx_trade_request')
  })
})
