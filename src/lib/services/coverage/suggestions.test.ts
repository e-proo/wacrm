import { describe, expect, it } from 'vitest'
import {
  buildCoverageSuggestions,
  type OfferLike,
  type RegionRef,
  type RequestLike,
} from './suggestions'

const REGIONS: RegionRef[] = [
  { id: '11111111-1111-1111-1111-111111111111', macro_region: 'north' },
  { id: '22222222-2222-2222-2222-222222222222', macro_region: 'south' },
  { id: '33333333-3333-3333-3333-333333333333', macro_region: 'north' },
]

function offer(overrides: Partial<OfferLike> = {}): OfferLike {
  return {
    id: 'offer-1',
    service_id: 'svc',
    provider_contact_id: 'contact-p',
    reference_code: 'OFF-1',
    total_amount: '700000',
    reserved_amount: '0',
    fulfilled_amount: '0',
    currency: 'SAR',
    commission_per_thousand: '7',
    commission_currency: 'SAR',
    attributes: {
      receive_region_id: '11111111-1111-1111-1111-111111111111',
      receive_method: 'networks',
      pay_region_id: null,
      pay_method: 'any',
    },
    status: 'active',
    ...overrides,
  }
}

function request(overrides: Partial<RequestLike> = {}): RequestLike {
  return {
    id: 'req-1',
    service_id: 'svc',
    requester_contact_id: 'contact-r',
    requested_amount: '300000',
    reserved_amount: '0',
    fulfilled_amount: '0',
    currency: 'SAR',
    attributes: {
      receive_region_id: '11111111-1111-1111-1111-111111111111',
      receive_method: 'any',
      pay_region_id: null,
      pay_method: 'any',
    },
    status: 'active',
    ...overrides,
  }
}

describe('buildCoverageSuggestions', () => {
  it('produces a ready single match and computes the remainder + commission', () => {
    const { forRequests, forOffers } = buildCoverageSuggestions(
      [offer()],
      [request()],
      REGIONS,
    )
    expect(forRequests).toHaveLength(1)
    const row = forRequests[0]
    expect(row.fully_coverable).toBe(true)
    expect(row.singles).toHaveLength(1)
    const leg = row.singles[0]
    // 700K offered, 300K requested → 100% covered, 400K remain.
    expect(leg.amount).toBe('300000.0000')
    expect(leg.offer_headroom_after).toBe('400000.0000')
    expect(leg.request_remaining_after).toBe('0.0000')
    // 7 per 1000 on 300K = 2,100.
    expect(leg.commission_amount).toBe('2100.0000')
    // Same city → region 100, methods any-vs-networks → 75.
    // score = 0.6*100 + 0.4*75 = 90.
    expect(leg.score).toBe(90)
    expect(forOffers['offer-1']).toHaveLength(1)
  })

  it('serves a second request from the remainder after a partial booking', () => {
    const first = request()
    const second = request({ id: 'req-2', requested_amount: '400000' })
    const { forRequests } = buildCoverageSuggestions(
      [offer({ reserved_amount: '300000' })],
      [first, second],
      REGIONS,
    )
    const row2 = forRequests.find((r) => r.request_id === 'req-2')
    expect(row2).toBeDefined()
    expect(row2?.singles[0]?.amount).toBe('400000.0000')
    expect(row2?.singles[0]?.offer_headroom_after).toBe('0.0000')
    expect(row2?.fully_coverable).toBe(true)
  })

  it('bundles two offers to fully cover one request', () => {
    const offers = [
      offer({ id: 'offer-a', total_amount: '500000' }),
      offer({ id: 'offer-b', total_amount: '500000' }),
    ]
    const req = request({ requested_amount: '1000000' })
    const { forRequests } = buildCoverageSuggestions(offers, [req], REGIONS)
    const row = forRequests[0]
    expect(row.singles).toHaveLength(2)
    expect(row.singles[0]?.offer_headroom_after).toBe('0.0000')
    expect(row.bundle).not.toBeNull()
    expect(row.bundle).toHaveLength(2)
    expect(row.bundle_coverage).toBe(1)
    expect(row.fully_coverable).toBe(true)
    // Bundle commission = 7‰ × 1M = 7,000.
    expect(row.bundle_commission_amount).toBe('7000.0000')
  })

  it('excludes pairs across conflicting macro regions', () => {
    const { forRequests } = buildCoverageSuggestions(
      [offer()],
      [request({ attributes: { receive_region_id: '22222222-2222-2222-2222-222222222222' } })],
      REGIONS,
    )
    expect(forRequests[0]?.singles).toHaveLength(0)
    expect(forRequests[0]?.bundle).toBeNull()
  })

  it('keeps same-macro different-city pairs at a lower score', () => {
    const { forRequests } = buildCoverageSuggestions(
      [offer()],
      [request({ attributes: { receive_region_id: '33333333-3333-3333-3333-333333333333' } })],
      REGIONS,
    )
    const leg = forRequests[0]?.singles[0]
    expect(leg).toBeDefined()
    // Region 70 (same macro), methods 75 → 0.6*70 + 0.4*75 = 72.
    expect(leg?.score).toBe(72)
  })

  it('gates on currency and service mismatch', () => {
    const { forRequests: byCurrency } = buildCoverageSuggestions(
      [offer({ currency: 'USD' })],
      [request()],
      REGIONS,
    )
    expect(byCurrency[0]?.singles).toHaveLength(0)
    const { forRequests: byService } = buildCoverageSuggestions(
      [offer({ service_id: 'other' })],
      [request()],
      REGIONS,
    )
    expect(byService[0]?.singles).toHaveLength(0)
  })

  it('ignores draft and exhausted offers', () => {
    const { forRequests: byStatus } = buildCoverageSuggestions(
      [offer({ status: 'draft' })],
      [request()],
      REGIONS,
    )
    expect(byStatus[0]?.singles).toHaveLength(0)
    const { forRequests: byExhausted } = buildCoverageSuggestions(
      [offer({ reserved_amount: '700000' })],
      [request()],
      REGIONS,
    )
    expect(byExhausted[0]?.singles).toHaveLength(0)
  })

  it('treats a null commission rate as zero commission', () => {
    const { forRequests } = buildCoverageSuggestions(
      [offer({ commission_per_thousand: null })],
      [request()],
      REGIONS,
    )
    expect(forRequests[0]?.singles[0]?.commission_amount).toBe('0.0000')
    expect(forRequests[0]?.singles[0]?.commission_currency).toBe('SAR')
  })

  it('does not build a redundant bundle when one offer covers everything', () => {
    const { forRequests } = buildCoverageSuggestions(
      [offer({ total_amount: '1000000' })],
      [request({ requested_amount: '300000' })],
      REGIONS,
    )
    expect(forRequests[0]?.fully_coverable).toBe(true)
    expect(forRequests[0]?.bundle).toBeNull()
  })

  it('matches an anti-parallel (mirror) corridor — offer liquidity in the south, request wants the north', () => {
    // The exact shape the business created: the offer states where
    // its liquidity sits (south) and where it expects payment
    // (north); the request mirrors it.
    const mirrorOffer = offer({
      attributes: {
        receive_region_id: '22222222-2222-2222-2222-222222222222', // south
        receive_method: 'any',
        pay_region_id: '11111111-1111-1111-1111-111111111111', // north
        pay_method: 'any',
      },
    })
    const mirrorRequest = request({
      attributes: {
        receive_region_id: '11111111-1111-1111-1111-111111111111', // north
        receive_method: 'networks',
        pay_region_id: '22222222-2222-2222-2222-222222222222', // south
        pay_method: 'any',
      },
    })
    const { forRequests } = buildCoverageSuggestions(
      [mirrorOffer],
      [mirrorRequest],
      REGIONS,
    )
    const leg = forRequests[0]?.singles[0]
    expect(leg).toBeDefined()
    expect(leg?.orientation).toBe('mirror')
    // Both legs same-city → region 100; methods networks-vs-any → 75.
    expect(leg?.score).toBe(90)
    expect(leg?.amount).toBe('300000.0000')
  })

  it('prefers the better of the two orientations', () => {
    // Direct: same delivery city, pay unspecified → region 100.
    // Mirror: anchor vs pay(any)… still valid but weaker methods
    // are identical here; direct must win on region.
    const directOffer = offer({
      attributes: {
        receive_region_id: '11111111-1111-1111-1111-111111111111',
        receive_method: 'networks',
        pay_region_id: '22222222-2222-2222-2222-222222222222',
        pay_method: 'any',
      },
    })
    const req = request({
      attributes: {
        receive_region_id: '11111111-1111-1111-1111-111111111111',
        receive_method: 'networks',
        pay_region_id: '22222222-2222-2222-2222-222222222222',
        pay_method: 'any',
      },
    })
    const { forRequests } = buildCoverageSuggestions([directOffer], [req], REGIONS)
    const leg = forRequests[0]?.singles[0]
    // Direct: region 100 (both legs same-city), methods
    // (networks=100 + any-vs-any=75)/2 = 88 → 0.6*100 + 0.4*88 = 95.
    expect(leg?.orientation).toBe('direct')
    expect(leg?.score).toBe(95)
  })

  it('flags same-type anti-parallel rows as complementary pairs', () => {
    // Two OFFERS that are actually one offer vs one request.
    const offerA = offer({
      id: 'offer-a',
      attributes: {
        receive_region_id: '22222222-2222-2222-2222-222222222222', // south
        receive_method: 'any',
        pay_region_id: '11111111-1111-1111-1111-111111111111', // north
        pay_method: 'any',
      },
    })
    const offerB = offer({
      id: 'offer-b',
      total_amount: '100000',
      attributes: {
        receive_region_id: '11111111-1111-1111-1111-111111111111', // north
        receive_method: 'any',
        pay_region_id: '22222222-2222-2222-2222-222222222222', // south
        pay_method: 'any',
      },
    })
    const { complementaryPairs, forRequests } = buildCoverageSuggestions(
      [offerA, offerB],
      [],
      REGIONS,
    )
    expect(forRequests).toHaveLength(0)
    expect(complementaryPairs).toHaveLength(1)
    const pair = complementaryPairs[0]
    expect(pair.a_id).toBe('offer-a')
    expect(pair.b_id).toBe('offer-b')
    expect(pair.currency).toBe('SAR')
    expect(pair.amount).toBe('100000.0000')
  })

  it('does NOT pair two same-side offers as complementary', () => {
    const offerA = offer({ id: 'offer-a' })
    const offerB = offer({ id: 'offer-b' })
    const { complementaryPairs } = buildCoverageSuggestions(
      [offerA, offerB],
      [],
      REGIONS,
    )
    expect(complementaryPairs).toHaveLength(0)
  })
})
