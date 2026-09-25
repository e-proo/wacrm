// ============================================================
// Coverage suggestion engine — pure, in-memory matcher over
// ACTIVE coverage rows.
//
// CANONICAL DOMESTIC BUSINESS RULE
// --------------------------------
// Record type is NOT free-form and is NOT inferred from words such
// as "راجع" or "عمولة". It is derived from the CUSTOMER legs:
//
//   OFFER   = customer PAYS in SOUTH and RECEIVES in NORTH.
//             Commission is returned to the customer (راجع للعميل).
//
//   REQUEST = customer PAYS in NORTH and RECEIVES in SOUTH.
//             Customer pays the commission (عمولة).
//
// Therefore a bookable offer/request pair is necessarily
// anti-parallel (mirror):
//   request.receive ≈ offer.pay  (south)
//   request.pay     ≈ offer.receive (north)
//
// Direct same-direction matching is deliberately NOT bookable.
// Same-type anti-parallel rows are surfaced only as legacy/data
// anomalies so an operator can correct the misclassified row.
// ============================================================

import { Decimal, formatDecimal } from '@/lib/services/shared/money/decimal'
import type { MoneyJson } from '@/lib/services/shared/money/money-json'
import { readCoverageAttributes, type CoverageMethod } from './attributes'
import { classifyCoverageDirection } from './direction'


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

// Keep the historical union for callers that render old audit data. New
// canonical bookable suggestions emitted by this module are always 'mirror'.
export type MatchOrientation = 'direct' | 'mirror'

export interface SuggestionLeg extends MoneyJson {
  offer_id: string
  request_id: string
  score: number
  region_score: number
  method_score: number
  orientation: MatchOrientation
  commission_per_thousand: string | null
  commission_currency: string
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
  singles: SuggestionLeg[]
  bundle: SuggestionLeg[] | null
  bundle_coverage: number
  bundle_commission_amount: string
  fully_coverable: boolean
}

export interface OfferCandidate extends MoneyJson {
  request_id: string
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
 * Same-type anti-parallel rows are not valid bookable pairs. They are
 * returned as repair hints for legacy/misclassified data only.
 */
export interface ComplementaryPair extends MoneyJson {
  a_type: 'offer' | 'request'
  a_id: string
  b_type: 'offer' | 'request'
  b_id: string
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
  return formatDecimal(value, SCALE)
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
  // Canonical classification itself requires both macros. This helper still
  // treats an unspecified secondary matching preference as neutral so legacy
  // method/region scoring remains stable after classification succeeds.
  if (!a || !b) return { score: 60, compatible: true }
  if (a === b) return { score: 100, compatible: true }
  const aMacro = regionsById.get(a)?.macro_region
  const bMacro = regionsById.get(b)?.macro_region
  if (!aMacro || !bMacro) return { score: 60, compatible: true }
  if (aMacro === bMacro) return { score: 70, compatible: true }
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

function orientationScore(
  a: RowLegs,
  b: RowLegs,
  regionsById: Map<string, RegionRef>,
): OrientationResult | null {
  if (!a.receive_region || !a.pay_region || !b.receive_region || !b.pay_region) {
    return null
  }

  const receiveLeg = legRegionScore(a.receive_region, b.receive_region, regionsById)
  const payLeg = legRegionScore(a.pay_region, b.pay_region, regionsById)
  if (!receiveLeg.compatible || !payLeg.compatible) return null

  const regionScore = Math.round((receiveLeg.score + payLeg.score) / 2)
  const methodScore = Math.round(
    (methodPairScore(a.receive_method, b.receive_method) +
      methodPairScore(a.pay_method, b.pay_method)) /
      2,
  )
  return {
    regionScore,
    methodScore,
    score: Math.round(0.6 * regionScore + 0.4 * methodScore),
  }
}

function toLegs(attrs: Record<string, unknown> | null): RowLegs {
  const parsed = readCoverageAttributes(attrs)
  return {
    receive_region: parsed.receive_region_id,
    pay_region: parsed.pay_region_id,
    receive_method: parsed.receive_method,
    pay_method: parsed.pay_method,
  }
}

function classifyRow(
  legs: RowLegs,
  regionsById: Map<string, RegionRef>,
) {
  const payMacro = legs.pay_region
    ? regionsById.get(legs.pay_region)?.macro_region ?? null
    : null
  const receiveMacro = legs.receive_region
    ? regionsById.get(legs.receive_region)?.macro_region ?? null
    : null
  return classifyCoverageDirection(payMacro, receiveMacro)
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

  const requestLegs = toLegs(request.attributes)
  const offerLegs = toLegs(offer.attributes)

  // Fail closed: a row stored in the wrong table is not silently treated as
  // valid business data. Domestic request must be north->south; offer must be
  // south->north.
  const requestDirection = classifyRow(requestLegs, regionsById)
  const offerDirection = classifyRow(offerLegs, regionsById)
  if (!requestDirection.supported || requestDirection.kind !== 'request') return null
  if (!offerDirection.supported || offerDirection.kind !== 'offer') return null

  // Only anti-parallel matching is legal for a canonical pair:
  // request.receive(south) <-> offer.pay(south)
  // request.pay(north)     <-> offer.receive(north)
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
  if (!mirror) return null

  return {
    legAmount: Decimal.min(remaining, headroom),
    score: mirror.score,
    regionScore: mirror.regionScore,
    methodScore: mirror.methodScore,
    orientation: 'mirror',
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
      if (a.service_id !== b.service_id || a.currency !== b.currency) continue
      if (!BOOKABLE_STATUSES.has(a.status) || !BOOKABLE_STATUSES.has(b.status)) continue
      if (a.capacity.lte(0) || b.capacity.lte(0)) continue

      const aDirection = classifyRow(a, regionsById)
      const bDirection = classifyRow(b, regionsById)
      // Only flag a same-table pair when one row belongs to the opposite
      // canonical type. Two valid same-direction offers/requests are not a pair.
      if (
        !aDirection.supported ||
        !bDirection.supported ||
        aDirection.kind === bDirection.kind
      ) {
        continue
      }

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

  // Preserve every active row in the anomaly view, including a row whose
  // stored table disagrees with its canonical direction.
  for (const request of requests) {
    if (!BOOKABLE_STATUSES.has(request.status)) continue
    const remaining = requestRemaining(request)
    if (remaining.lte(0)) continue
    genericRows.push({
      type: 'request',
      id: request.id,
      service_id: request.service_id,
      currency: request.currency,
      status: request.status,
      ...toLegs(request.attributes),
      capacity: remaining,
    })

    const requestDirection = classifyRow(toLegs(request.attributes), regionsById)
    // A misclassified/underspecified request is not offered bookable matches.
    if (!requestDirection.supported || requestDirection.kind !== 'request') continue

    const legs: Array<{ offer: OfferLike; core: PairCore }> = []
    for (const offer of offers) {
      const core = evaluatePair(request, offer, regionsById)
      if (core) legs.push({ offer, core })
    }
    legs.sort((a, b) => {
      if (b.core.score !== a.core.score) return b.core.score - a.core.score
      return b.core.legAmount.comparedTo(a.core.legAmount)
    })

    const singles = legs.map(({ offer, core }) => buildLeg(request, offer, core))
    const bestSingle = legs[0]
    const bestCoversAll = bestSingle !== undefined && bestSingle.core.legAmount.gte(remaining)
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
      fully_coverable: bestCoversAll || bundleCoverage >= 1,
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
        orientation: 'mirror',
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
    genericRows.push({
      type: 'offer',
      id: offer.id,
      service_id: offer.service_id,
      currency: offer.currency,
      status: offer.status,
      ...toLegs(offer.attributes),
      capacity: headroom,
    })
  }

  for (const list of Object.values(forOffers)) {
    list.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return new Decimal(b.amount).comparedTo(new Decimal(a.amount))
    })
  }

  return {
    forRequests,
    forOffers,
    complementaryPairs: findComplementaryPairs(genericRows, regionsById),
  }
}
