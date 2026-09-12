// ============================================================
// Coverage suggestion engine — pure, in-memory matcher over
// ACTIVE coverage rows.
//
// Core principle (agreed with the business):
//   The record TYPE (offer vs request) does not decide a match —
//   the LEGS do. Every row declares two legs:
//     receive leg — where the covered money lands for this row
//     pay leg     — where the counter-payment happens
//   Two rows are complementary when their legs anti-parallel:
//     A.receive ≈ B.pay  AND  A.pay ≈ B.receive   (mirror)
//   A direct reading (A.receive ≈ B.receive AND A.pay ≈ B.pay) is
//   also accepted — some desks author the offer from the delivery
//   side. The engine scores BOTH orientations and keeps the best.
//
// Region fit per leg: same city = 100, same macro region
// (north / south / international) = 70, one side unspecified = 60,
// conflicting macros = that orientation fails. Methods are soft:
// 'any' is a wildcard (75), concrete mismatch 40 — never a gate.
//
// Suggestions are COMPUTED LIVE, never persisted — the rows in
// coverage_offers / coverage_requests stay the single source of
// truth. Booking still goes through the atomic
// `reserve_coverage_match` RPC; a "bundle" is a presentation plan
// whose legs are booked one by one through the same RPC.
//
// Same-type mirror pairs (two offers or two requests that are
// actually opposite sides) are surfaced separately as
// complementary pairs — they cannot book through the RPC until the
// operator creates the missing counterpart row.
// ============================================================

import { Decimal } from 'decimal.js'
import { readCoverageAttributes, type CoverageMethod } from './attributes'

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP })

export interface RegionRef {
  id: string
  macro_region: 'north' | 'south' | 'international'
}

export interface OfferLike {
  id: string
  service_id: string
  provider_contact_id: string
  reference_code: string
  total_amount: string
  reserved_amount: string
  fulfilled_amount: string
  currency: string
  commission_per_thousand: string | null
  commission_currency: string | null
  attributes: Record<string, unknown> | null
  status: string
}

export interface RequestLike {
  id: string
  service_id: string
  requester_contact_id: string
  requested_amount: string
  reserved_amount: string
  fulfilled_amount: string
  currency: string
  attributes: Record<string, unknown> | null
  status: string
}

export type MatchOrientation = 'direct' | 'mirror'

/** One bookable leg: an offer covering part of a request. */
export interface SuggestionLeg {
  offer_id: string
  request_id: string
  /** Portion this leg would book from the offer into the request. */
  amount: string
  currency: string
  /** 0..100 compatibility (region + methods). */
  score: number
  region_score: number
  method_score: number
  /** How the legs met: direct or anti-parallel (mirror). */
  orientation: MatchOrientation
  commission_per_thousand: string | null
  commission_currency: string
  /** amount × per_thousand ÷ 1000 — exact. */
  commission_amount: string
  offer_headroom: string
  offer_headroom_after: string
  request_remaining: string
  request_remaining_after: string
}

export interface RequestSuggestions {
  request_id: string
  currency: string
  request_remaining: string
  /** Best single-offer matches, sorted by score then headroom. */
  singles: SuggestionLeg[]
  /** Multi-offer plan covering the request (null when redundant). */
  bundle: SuggestionLeg[] | null
  /** 0..1 — how much of the request the bundle covers. */
  bundle_coverage: number
  /** Sum of the bundle legs' commissions. */
  bundle_commission_amount: string
  /** True when a single or the bundle covers the request fully. */
  fully_coverable: boolean
}

export interface OfferCandidate {
  request_id: string
  /** Portion of the offer this request would consume. */
  amount: string
  currency: string
  score: number
  region_score: number
  method_score: number
  orientation: MatchOrientation
  offer_headroom: string
  offer_headroom_after: string
  request_remaining: string
  request_remaining_after: string
  commission_per_thousand: string | null
  commission_currency: string
  commission_amount: string
}

/**
 * Two rows of the SAME type whose legs are anti-parallel — e.g.
 * two offers that are actually one offer vs one request. They
 * cannot book as-is (the RPC needs one row of each type); the UI
 * surfaces them so the operator creates the missing counterpart.
 */
export interface ComplementaryPair {
  a_type: 'offer' | 'request'
  a_id: string
  b_type: 'offer' | 'request'
  b_id: string
  currency: string
  /** min(capacity of both sides) — the dealable amount. */
  amount: string
  score: number
  region_score: number
  method_score: number
}

const BOOKABLE_STATUSES = new Set(['active', 'partially_reserved'])
const SCALE = 4

function d(input: string | number): Decimal {
  return new Decimal(input)
}

function fmt(value: Decimal): string {
  return value.toFixed(SCALE)
}

function methodPairScore(a: CoverageMethod, b: CoverageMethod): number {
  if (a === 'any' || b === 'any') return 75
  return a === b ? 100 : 40
}

function legRegionScore(
  a: string | null,
  b: string | null,
  regionsById: Map<string, RegionRef>,
): { score: number; compatible: boolean } {
  // Either side unspecified → treat as "no preference".
  if (!a || !b) return { score: 60, compatible: true }
  if (a === b) return { score: 100, compatible: true }
  const aMacro = regionsById.get(a)?.macro_region
  const bMacro = regionsById.get(b)?.macro_region
  // Unknown region ids (deleted rows) → don't block, stay neutral.
  if (!aMacro || !bMacro) return { score: 60, compatible: true }
  if (aMacro === bMacro) return { score: 70, compatible: true }
  // North vs South (or international) mismatch — incompatible on
  // this leg.
  return { score: 0, compatible: false }
}

interface OrientationResult {
  score: number
  regionScore: number
  methodScore: number
}

interface RowLegs {
  receive_region: string | null
  pay_region: string | null
  receive_method: CoverageMethod
  pay_method: CoverageMethod
}

/**
 * Score ONE orientation: (reqReceive vs offReceive) and
 * (reqPay vs offPay). A leg only counts when BOTH sides declare a
 * region — unspecified legs are neutral, never dilute the score.
 * A CONFLICTING leg (declared + macro mismatch) fails the whole
 * orientation.
 */
function orientationScore(
  requestLegs: RowLegs,
  offerLegs: RowLegs,
  regionsById: Map<string, RegionRef>,
): OrientationResult | null {
  // ANCHOR RULE: the requester's wanted-delivery city must be
  // declared on BOTH sides of the primary leg, or the orientation
  // is meaningless (unspecified = wildcard is allowed on the pay
  // leg, never on the anchor).
  if (!requestLegs.receive_region || !offerLegs.receive_region) return null

  const receiveLeg = legRegionScore(
    requestLegs.receive_region,
    offerLegs.receive_region,
    regionsById,
  )
  const payLeg = legRegionScore(
    requestLegs.pay_region,
    offerLegs.pay_region,
    regionsById,
  )
  if (!receiveLeg.compatible || !payLeg.compatible) return null

  const constrained: number[] = []
  if (requestLegs.receive_region && offerLegs.receive_region) {
    constrained.push(receiveLeg.score)
  }
  if (requestLegs.pay_region && offerLegs.pay_region) {
    constrained.push(payLeg.score)
  }
  const regionScore =
    constrained.length > 0
      ? Math.round(
          constrained.reduce((a, b) => a + b, 0) / constrained.length,
        )
      : 60

  const methodScore = Math.round(
    (methodPairScore(requestLegs.receive_method, offerLegs.receive_method) +
      methodPairScore(requestLegs.pay_method, offerLegs.pay_method)) /
      2,
  )
  return {
    regionScore,
    methodScore,
    score: Math.round(0.6 * regionScore + 0.4 * methodScore),
  }
}

function offerHeadroom(o: OfferLike): Decimal {
  return d(o.total_amount).minus(o.reserved_amount).minus(o.fulfilled_amount)
}

function requestRemaining(r: RequestLike): Decimal {
  return d(r.requested_amount).minus(r.reserved_amount).minus(r.fulfilled_amount)
}

interface PairCore {
  legAmount: Decimal
  score: number
  regionScore: number
  methodScore: number
  orientation: MatchOrientation
  requestRemaining: Decimal
  offerHeadroom: Decimal
}

function evaluatePair(
  request: RequestLike,
  offer: OfferLike,
  regionsById: Map<string, RegionRef>,
): PairCore | null {
  if (request.service_id !== offer.service_id) return null
  if (request.currency !== offer.currency) return null
  if (!BOOKABLE_STATUSES.has(request.status)) return null
  if (!BOOKABLE_STATUSES.has(offer.status)) return null

  const remaining = requestRemaining(request)
  const headroom = offerHeadroom(offer)
  if (remaining.lte(0) || headroom.lte(0)) return null

  const requestAttrs = readCoverageAttributes(request.attributes)
  const offerAttrs = readCoverageAttributes(offer.attributes)
  const requestLegs: RowLegs = {
    receive_region: requestAttrs.receive_region_id,
    pay_region: requestAttrs.pay_region_id,
    receive_method: requestAttrs.receive_method,
    pay_method: requestAttrs.pay_method,
  }
  const offerLegs: RowLegs = {
    receive_region: offerAttrs.receive_region_id,
    pay_region: offerAttrs.pay_region_id,
    receive_method: offerAttrs.receive_method,
    pay_method: offerAttrs.pay_method,
  }

  // Direct: receive↔receive, pay↔pay.
  const direct = orientationScore(requestLegs, offerLegs, regionsById)
  // Mirror: receive↔offer.pay, pay↔offer.receive (anti-parallel
  // corridor — the classic north↔south coverage shape).
  const mirror = orientationScore(
    requestLegs,
    {
      receive_region: offerLegs.pay_region,
      pay_region: offerLegs.receive_region,
      receive_method: offerLegs.pay_method,
      pay_method: offerLegs.receive_method,
    },
    regionsById,
  )

  let best: OrientationResult | null = null
  let orientation: MatchOrientation = 'direct'
  for (const [result, orient] of [
    [direct, 'direct'],
    [mirror, 'mirror'],
  ] as Array<[OrientationResult | null, MatchOrientation]>) {
    if (!result) continue
    if (!best || result.score > best.score) {
      best = result
      orientation = orient
    }
  }
  if (!best) return null

  return {
    legAmount: Decimal.min(remaining, headroom),
    score: best.score,
    regionScore: best.regionScore,
    methodScore: best.methodScore,
    orientation,
    requestRemaining: remaining,
    offerHeadroom: headroom,
  }
}

function buildLeg(
  request: RequestLike,
  offer: OfferLike,
  core: PairCore,
): SuggestionLeg {
  const perThousand = offer.commission_per_thousand
  const commissionAmount =
    perThousand === null
      ? new Decimal(0)
      : core.legAmount.times(perThousand).dividedBy(1000)
  return {
    offer_id: offer.id,
    request_id: request.id,
    amount: fmt(core.legAmount),
    currency: offer.currency,
    score: core.score,
    region_score: core.regionScore,
    method_score: core.methodScore,
    orientation: core.orientation,
    commission_per_thousand: perThousand,
    commission_currency: offer.commission_currency ?? offer.currency,
    commission_amount: fmt(commissionAmount),
    offer_headroom: fmt(core.offerHeadroom),
    offer_headroom_after: fmt(core.offerHeadroom.minus(core.legAmount)),
    request_remaining: fmt(core.requestRemaining),
    request_remaining_after: fmt(core.requestRemaining.minus(core.legAmount)),
  }
}

/** Bundle legs: greedy by score then headroom until the request is covered. */
function buildBundle(
  request: RequestLike,
  legs: Array<{ offer: OfferLike; core: PairCore }>,
): SuggestionLeg[] {
  const remaining = requestRemaining(request)
  const bundle: SuggestionLeg[] = []
  let left = remaining
  for (const { offer, core } of legs) {
    if (left.lte(0)) break
    const take = Decimal.min(left, core.legAmount)
    if (take.lte(0)) continue
    bundle.push(
      buildLeg(request, offer, {
        ...core,
        legAmount: take,
        requestRemaining: remaining,
      }),
    )
    left = left.minus(take)
  }
  return bundle
}

interface GenericRow extends RowLegs {
  type: 'offer' | 'request'
  id: string
  service_id: string
  currency: string
  status: string
  capacity: Decimal
}

/**
 * Same-type mirror pairs (offer×offer / request×request) whose
 * legs are anti-parallel. Informational only — booking requires
 * one row of each type.
 */
function findComplementaryPairs(
  rows: GenericRow[],
  regionsById: Map<string, RegionRef>,
): ComplementaryPair[] {
  const pairs: ComplementaryPair[] = []
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]
      const b = rows[j]
      if (a.type !== b.type) continue
      if (a.service_id !== b.service_id) continue
      if (a.currency !== b.currency) continue
      if (!BOOKABLE_STATUSES.has(a.status) || !BOOKABLE_STATUSES.has(b.status)) continue
      if (a.capacity.lte(0) || b.capacity.lte(0)) continue

      // Same-type pairs are only meaningful when the legs are
      // anti-parallel — the direct reading would mean two rows on
      // the SAME side of the corridor, which is not a deal.
      const mirrored = orientationScore(
        a,
        {
          receive_region: b.pay_region,
          pay_region: b.receive_region,
          receive_method: b.pay_method,
          pay_method: b.receive_method,
        },
        regionsById,
      )
      if (!mirrored) continue

      pairs.push({
        a_type: a.type,
        a_id: a.id,
        b_type: b.type,
        b_id: b.id,
        currency: a.currency,
        amount: fmt(Decimal.min(a.capacity, b.capacity)),
        score: mirrored.score,
        region_score: mirrored.regionScore,
        method_score: mirrored.methodScore,
      })
    }
  }
  return pairs.sort((x, y) => y.score - x.score)
}

/**
 * Match every bookable request against every bookable offer.
 *
 * Returns BOTH directions in one pass:
 *   • forRequests — per request: ranked singles + a greedy bundle
 *   • forOffers   — per offer: ranked consuming requests
 *   • complementaryPairs — same-type anti-parallel rows
 */
export function buildCoverageSuggestions(
  offers: OfferLike[],
  requests: RequestLike[],
  regions: RegionRef[],
): {
  forRequests: RequestSuggestions[]
  forOffers: Record<string, OfferCandidate[]>
  complementaryPairs: ComplementaryPair[]
} {
  const regionsById = new Map(regions.map((r) => [r.id, r]))
  const forOffers: Record<string, OfferCandidate[]> = {}

  const genericRows: GenericRow[] = []

  const forRequests: RequestSuggestions[] = []

  for (const request of requests) {
    if (!BOOKABLE_STATUSES.has(request.status)) continue
    const remaining = requestRemaining(request)
    if (remaining.lte(0)) continue

    const requestAttrs = readCoverageAttributes(request.attributes)
    genericRows.push({
      type: 'request',
      id: request.id,
      service_id: request.service_id,
      currency: request.currency,
      status: request.status,
      receive_region: requestAttrs.receive_region_id,
      pay_region: requestAttrs.pay_region_id,
      receive_method: requestAttrs.receive_method,
      pay_method: requestAttrs.pay_method,
      capacity: remaining,
    })

    const legs: Array<{ offer: OfferLike; core: PairCore }> = []
    for (const offer of offers) {
      const core = evaluatePair(request, offer, regionsById)
      if (!core) continue
      legs.push({ offer, core })
    }

    legs.sort((a, b) => {
      if (b.core.score !== a.core.score) return b.core.score - a.core.score
      return b.core.legAmount.comparedTo(a.core.legAmount)
    })

    const singles = legs.map(({ offer, core }) => buildLeg(request, offer, core))

    const bestSingle = legs[0]
    const bestCoversAll =
      bestSingle !== undefined && bestSingle.core.legAmount.gte(remaining)

    // Bundle only adds value when no single offer covers the whole
    // request and at least two offers are compatible.
    const bundle = !bestCoversAll && legs.length >= 2 ? buildBundle(request, legs) : null

    const bundleCoverage = bundle
      ? bundle
          .reduce((acc, leg) => acc.plus(leg.amount), new Decimal(0))
          .dividedBy(remaining)
          .toNumber()
      : 0
    const bundleCommission = bundle
      ? bundle.reduce((acc, leg) => acc.plus(leg.commission_amount), new Decimal(0))
      : new Decimal(0)

    forRequests.push({
      request_id: request.id,
      currency: request.currency,
      request_remaining: fmt(remaining),
      singles,
      bundle: bundle && bundle.length >= 2 ? bundle : null,
      bundle_coverage: bundleCoverage,
      bundle_commission_amount: fmt(bundleCommission),
      fully_coverable: bestCoversAll || (bundleCoverage >= 1),
    })

    for (const { offer, core } of legs) {
      const list = forOffers[offer.id] ?? []
      list.push({
        request_id: request.id,
        amount: fmt(core.legAmount),
        currency: request.currency,
        score: core.score,
        region_score: core.regionScore,
        method_score: core.methodScore,
        orientation: core.orientation,
        offer_headroom: fmt(core.offerHeadroom),
        offer_headroom_after: fmt(core.offerHeadroom.minus(core.legAmount)),
        request_remaining: fmt(core.requestRemaining),
        request_remaining_after: fmt(core.requestRemaining.minus(core.legAmount)),
        commission_per_thousand: offer.commission_per_thousand,
        commission_currency: offer.commission_currency ?? offer.currency,
        commission_amount: fmt(
          offer.commission_per_thousand === null
            ? new Decimal(0)
            : core.legAmount.times(offer.commission_per_thousand).dividedBy(1000),
        ),
      })
      forOffers[offer.id] = list
    }
  }

  for (const offer of offers) {
    if (!BOOKABLE_STATUSES.has(offer.status)) continue
    const headroom = offerHeadroom(offer)
    if (headroom.lte(0)) continue
    const offerAttrs = readCoverageAttributes(offer.attributes)
    genericRows.push({
      type: 'offer',
      id: offer.id,
      service_id: offer.service_id,
      currency: offer.currency,
      status: offer.status,
      receive_region: offerAttrs.receive_region_id,
      pay_region: offerAttrs.pay_region_id,
      receive_method: offerAttrs.receive_method,
      pay_method: offerAttrs.pay_method,
      capacity: headroom,
    })
  }

  for (const list of Object.values(forOffers)) {
    list.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return new Decimal(b.amount).comparedTo(new Decimal(a.amount))
    })
  }

  const complementaryPairs = findComplementaryPairs(genericRows, regionsById)

  return { forRequests, forOffers, complementaryPairs }
}
