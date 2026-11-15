import { describe, expect, it } from 'vitest'
import { coverageSourcingIdempotencyKey, coverageSourcingCorrelationId } from './task-idempotency'

const sample = {
  coverageRequestId: '11111111-1111-4111-8111-111111111111',
  agentId: '22222222-2222-4222-8222-222222222222',
  revisionId: '33333333-3333-4333-8333-333333333333',
}
const A = '44444444-4444-4444-8444-444444444444'
const B = '55555555-5555-4555-8555-555555555555'

describe('Coverage Agent Task durable manual submission idempotency', () => {
  it('reuses identical keys on a network retry of the same manual submission', () => {
    const input = { ...sample, manualSubmissionId: A }
    expect(coverageSourcingIdempotencyKey(input)).toBe(coverageSourcingIdempotencyKey(input))
    expect(coverageSourcingCorrelationId(input)).toBe(coverageSourcingCorrelationId(input))
  })
  it('allows a new task after a terminal task by using a new submitted UUID', () => {
    expect(coverageSourcingIdempotencyKey({...sample, manualSubmissionId: A}))
      .not.toBe(coverageSourcingIdempotencyKey({...sample, manualSubmissionId: B}))
    expect(coverageSourcingCorrelationId({...sample, manualSubmissionId: A}))
      .not.toBe(coverageSourcingCorrelationId({...sample, manualSubmissionId: B}))
  })
  it('preserves deterministic trigger identity and cannot be changed by a manual ID', () => {
    const a = coverageSourcingIdempotencyKey({...sample, sourceKey:'business:event:42'})
    expect(a).toBe(coverageSourcingIdempotencyKey({
      ...sample, sourceKey:'business:event:42', manualSubmissionId:B,
    }))
    expect(a).not.toBe(coverageSourcingIdempotencyKey({...sample, manualSubmissionId:A}))
  })
  it('keeps compatibility for older callers without a submission ID', () => {
    expect(coverageSourcingIdempotencyKey(sample)).toBe(
      'coverage:sourcing:request:' + sample.coverageRequestId +
      ':agent:' + sample.agentId + ':revision:' + sample.revisionId,
    )
  })
})
