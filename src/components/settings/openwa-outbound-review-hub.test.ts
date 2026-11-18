import { describe, expect, it } from 'vitest'
import { summarizeOpenWAOutboundReviews } from './openwa-outbound-review-hub'

describe('OpenWA account outbound review summary', () => {
  it('aggregates separate connection IDs even when phone identities are identical', () => {
    const result = summarizeOpenWAOutboundReviews([
      { id: 'a', display_name: 'Session A', phone_identity: '123',
        outbound_review: { unreviewed_count: 2, reviewed_uncertain_count: 1 } },
      { id: 'b', display_name: 'Session B', phone_identity: '123',
        outbound_review: { unreviewed_count: 3, reviewed_uncertain_count: 2 } },
      { id: 'c', display_name: 'Session C', phone_identity: '456',
        outbound_review: { unreviewed_count: 0, reviewed_uncertain_count: 1 } },
    ])
    expect(result.unreviewed).toBe(5)
    expect(result.reviewedUncertain).toBe(4)
    expect(result.affectedCount).toBe(2)
    expect(result.affected.map(c => c.id)).toEqual(['a', 'b'])
  })

  it('handles the zero-pending state without creating any per-session review panels', () => {
    const result = summarizeOpenWAOutboundReviews([
      { id: 'a', display_name: null, phone_identity: null,
        outbound_review: { unreviewed_count: 0, reviewed_uncertain_count: 0 } },
      { id: 'b', display_name: null, phone_identity: null },
    ])
    expect(result).toMatchObject({
      unreviewed: 0, reviewedUncertain: 0, affectedCount: 0,
    })
    expect(result.affected).toEqual([])
  })

  it('does not allow a broken server count to appear as negative or NaN', () => {
    const result = summarizeOpenWAOutboundReviews([
      { id: 'a', display_name: null, phone_identity: null,
        outbound_review: { unreviewed_count: -1, reviewed_uncertain_count: Number.NaN } },
      { id: 'b', display_name: null, phone_identity: null,
        outbound_review: { unreviewed_count: 1, reviewed_uncertain_count: 0 } },
    ])
    expect(result.unreviewed).toBe(1)
    expect(result.reviewedUncertain).toBe(0)
    expect(result.affectedCount).toBe(1)
  })
})
