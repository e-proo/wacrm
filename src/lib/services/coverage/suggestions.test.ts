import { describe, expect, it } from 'vitest'
import {
  buildCoverageSuggestions,
  type OfferLike,
  type RegionRef,
  type RequestLike,
} from './suggestions'

const NORTH_A = '11111111-1111-1111-1111-111111111111'
const SOUTH_A = '22222222-2222-2222-2222-222222222222'
const NORTH_B = '33333333-3333-3333-3333-333333333333'
const SOUTH_B = '44444444-4444-4444-4444-444444444444'

const REGIONS: RegionRef[] = [
  { id: NORTH_A, macro_region: 'north' },
  { id: SOUTH_A, macro_region: 'south' },
  { id: NORTH_B, macro_region: 'north' },
  { id: SOUTH_B, macro_region: 'south' },
]

/** Canonical OFFER: customer pays SOUTH and receives NORTH. */
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
      receive_region_id: NORTH_A,
      receive_method: 'any',
      pay_region_id: SOUTH_A,
      pay_method: 'any',
    },
    status: 'active',
    ...overrides,
  }
}

/** Canonical REQUEST: customer pays NORTH and receives SOUTH. */
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
      receive_region_id: SOUTH_A,
      receive_method: 'any',
      pay_region_id: NORTH_A,
      pay_method: 'any',
    },
    status: 'active',
    ...overrides,
  }
}

describe('buildCoverageSuggestions canonical direction', () => {
  it('books only the anti-parallel canonical pair and computes commission', () => {
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
    expect(leg.orientation).toBe('mirror')
    expect(leg.amount).toBe('300000.0000')
    expect(leg.offer_headroom_after).toBe('400000.0000')
    expect(leg.request_remaining_after).toBe('0.0000')
    expect(leg.commission_amount).toBe('2100.0000') // 300K * 7 / 1000
    expect(leg.score).toBe(90) // exact regions + any methods
    expect(forOffers['offer-1']).toHaveLength(1)
  })

  it('bundles multiple canonical offers to cover one canonical request', () => {
    const offers = [
      offer({ id: 'offer-a', total_amount: '500000' }),
      offer({ id: 'offer-b', total_amount: '500000' }),
    ]
    const { forRequests } = buildCoverageSuggestions(
      offers,
      [request({ requested_amount: '1000000' })],
      REGIONS,
    )

    const row = forRequests[0]
    expect(row.singles).toHaveLength(2)
    expect(row.bundle).toHaveLength(2)
    expect(row.bundle_coverage).toBe(1)
    expect(row.fully_coverable).toBe(true)
    expect(row.bundle_commission_amount).toBe('7000.0000')
  })

  it('allows different cities inside the same macro corridor with lower score', () => {
    const { forRequests } = buildCoverageSuggestions(
      [offer()],
      [
        request({
          attributes: {
            receive_region_id: SOUTH_B,
            receive_method: 'any',
            pay_region_id: NORTH_A,
            pay_method: 'any',
          },
        }),
      ],
      REGIONS,
    )

    const leg = forRequests[0]?.singles[0]
    expect(leg).toBeDefined()
    // South city differs (70), north exact (100) => region 85;
    // methods any => 75; overall = 0.6*85 + 0.4*75 = 81.
    expect(leg?.score).toBe(81)
  })

  it('rejects a request row whose legs actually describe an offer', () => {
    const wrongRequest = request({
      attributes: {
        receive_region_id: NORTH_A,
        receive_method: 'any',
        pay_region_id: SOUTH_A,
        pay_method: 'any',
      },
    })
    const { forRequests, forOffers } = buildCoverageSuggestions(
      [offer()],
      [wrongRequest],
      REGIONS,
    )

    expect(forRequests).toHaveLength(0)
    expect(forOffers['offer-1']).toBeUndefined()
  })

  it('rejects an offer row whose legs actually describe a request', () => {
    const wrongOffer = offer({
      attributes: {
        receive_region_id: SOUTH_A,
        receive_method: 'any',
        pay_region_id: NORTH_A,
        pay_method: 'any',
      },
    })
    const { forRequests } = buildCoverageSuggestions(
      [wrongOffer],
      [request()],
      REGIONS,
    )

    expect(forRequests).toHaveLength(1)
    expect(forRequests[0]?.singles).toHaveLength(0)
  })

  it('does not accept direct same-direction matching as a bookable pair', () => {
    // Both rows are south->north. The old matcher could accept this as direct;
    // the canonical engine must reject the request as misclassified.
    const sameDirectionRequest = request({
      attributes: {
        receive_region_id: NORTH_A,
        receive_method: 'any',
        pay_region_id: SOUTH_A,
        pay_method: 'any',
      },
    })
    const { forRequests } = buildCoverageSuggestions(
      [offer()],
      [sameDirectionRequest],
      REGIONS,
    )
    expect(forRequests).toHaveLength(0)
  })

  it('still gates on currency, service, status, and exhausted headroom', () => {
    const byCurrency = buildCoverageSuggestions(
      [offer({ currency: 'USD' })],
      [request()],
      REGIONS,
    )
    expect(byCurrency.forRequests[0]?.singles).toHaveLength(0)

    const byService = buildCoverageSuggestions(
      [offer({ service_id: 'other' })],
      [request()],
      REGIONS,
    )
    expect(byService.forRequests[0]?.singles).toHaveLength(0)

    const byStatus = buildCoverageSuggestions(
      [offer({ status: 'draft' })],
      [request()],
      REGIONS,
    )
    expect(byStatus.forRequests[0]?.singles).toHaveLength(0)

    const exhausted = buildCoverageSuggestions(
      [offer({ reserved_amount: '700000' })],
      [request()],
      REGIONS,
    )
    expect(exhausted.forRequests[0]?.singles).toHaveLength(0)
  })

  it('does not build a redundant bundle when one canonical offer covers all', () => {
    const { forRequests } = buildCoverageSuggestions(
      [offer({ total_amount: '1000000' })],
      [request({ requested_amount: '300000' })],
      REGIONS,
    )
    expect(forRequests[0]?.fully_coverable).toBe(true)
    expect(forRequests[0]?.bundle).toBeNull()
  })

  it('flags same-table anti-parallel rows as legacy misclassification repair hints', () => {
    const canonicalOffer = offer({ id: 'offer-a' })
    const misclassifiedRequestDirectionStoredAsOffer = offer({
      id: 'offer-b',
      total_amount: '100000',
      attributes: {
        receive_region_id: SOUTH_A,
        receive_method: 'any',
        pay_region_id: NORTH_A,
        pay_method: 'any',
      },
    })

    const { complementaryPairs } = buildCoverageSuggestions(
      [canonicalOffer, misclassifiedRequestDirectionStoredAsOffer],
      [],
      REGIONS,
    )
    expect(complementaryPairs).toHaveLength(1)
    expect(complementaryPairs[0]?.a_type).toBe('offer')
    expect(complementaryPairs[0]?.amount).toBe('100000.0000')
  })

  it('does not flag two valid same-direction offers as complementary', () => {
    const { complementaryPairs } = buildCoverageSuggestions(
      [offer({ id: 'offer-a' }), offer({ id: 'offer-b' })],
      [],
      REGIONS,
    )
    expect(complementaryPairs).toHaveLength(0)
  })
})
