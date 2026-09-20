import { describe, expect, it } from 'vitest'
import {
  buildCoverageBusinessEvent,
  COVERAGE_BUSINESS_EVENT_MANIFESTS,
  getCoverageBusinessEventManifest,
} from './business-events'

describe('Coverage canonical business-event contract', () => {
  it('registers only business operations that exist in the current Coverage lifecycle', () => {
    const keys = COVERAGE_BUSINESS_EVENT_MANIFESTS.map((event) => event.key)

    expect(keys).toEqual([
      'coverage.offer.approved',
      'coverage.offer.activated',
      'coverage.offer.cancelled',
      'coverage.offer.fulfilled',
      'coverage.offer.expired',
      'coverage.request.approved',
      'coverage.request.activated',
      'coverage.request.cancelled',
      'coverage.request.fulfilled',
      'coverage.request.expired',
      'coverage.match.reserved',
      'coverage.match.released',
    ])

    expect(keys).not.toContain('coverage.match.confirmed')
    expect(keys).not.toContain('coverage.match.fulfilled')
  })

  it('uses embedded snapshots because Coverage subjects can change after the event', () => {
    for (const event of COVERAGE_BUSINESS_EVENT_MANIFESTS) {
      expect(event.snapshotPolicy, event.key).toBe('embedded_event_snapshot')
      expect(event.version, event.key).toBe(1)
      expect(event.domain, event.key).toBe('coverage')
    }
  })

  it('does not expose database availability statuses as public event keys', () => {
    const keys = COVERAGE_BUSINESS_EVENT_MANIFESTS.map((event) => event.key).join('\n')
    expect(keys).not.toContain('partially_reserved')
    expect(keys).not.toContain('fully_reserved')
    expect(keys).not.toContain('draft')
    expect(keys).not.toContain('active')
  })

  it('builds the standard platform envelope without deriving an event from row status', () => {
    const event = buildCoverageBusinessEvent({
      eventId: 'evt-coverage-1',
      type: 'coverage.match.reserved',
      occurredAt: '2026-09-20T00:00:00.000Z',
      accountId: 'account-1',
      subjectId: 'match-1',
      actor: { type: 'member', id: 'user-1' },
      correlationId: 'change-1',
      causationId: 'request-1',
      data: {
        offer_id: 'offer-1',
        request_id: 'request-1',
        matched_amount: '1000.0000',
        currency: 'SAR',
        status_after: 'fully_reserved',
      },
    })

    expect(event).toEqual({
      event_id: 'evt-coverage-1',
      type: 'coverage.match.reserved',
      version: 1,
      occurred_at: '2026-09-20T00:00:00.000Z',
      account_id: 'account-1',
      subject: { type: 'coverage_match', id: 'match-1' },
      actor: { type: 'member', id: 'user-1' },
      correlation_id: 'change-1',
      causation_id: 'request-1',
      data: {
        offer_id: 'offer-1',
        request_id: 'request-1',
        matched_amount: '1000.0000',
        currency: 'SAR',
        status_after: 'fully_reserved',
      },
    })
  })

  it('binds canonical approval events to the authoritative Coverage entities', () => {
    expect(getCoverageBusinessEventManifest('coverage.offer.approved').subjectTypes).toEqual([
      'coverage_offer',
    ])
    expect(getCoverageBusinessEventManifest('coverage.request.approved').subjectTypes).toEqual([
      'coverage_request',
    ])
  })
})
