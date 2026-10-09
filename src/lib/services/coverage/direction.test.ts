import { describe, expect, it } from 'vitest'
import { classifyCoverageDirection } from './direction'

describe('classifyCoverageDirection', () => {
  it('classifies south pay -> north receive as an offer with commission returned to customer', () => {
    const result = classifyCoverageDirection('south', 'north')
    expect(result).toMatchObject({
      supported: true,
      kind: 'offer',
      commissionEffect: 'customer_receives',
      customerTermAr: 'راجع للعميل',
      rateMarket: 'north',
      code: 'SOUTH_TO_NORTH_OFFER',
    })
  })

  it('classifies north pay -> south receive as a request with commission paid by customer', () => {
    const result = classifyCoverageDirection('north', 'south')
    expect(result).toMatchObject({
      supported: true,
      kind: 'request',
      commissionEffect: 'customer_pays',
      customerTermAr: 'عمولة',
      rateMarket: 'south',
      code: 'NORTH_TO_SOUTH_REQUEST',
    })
  })

  it('does not classify same-market traffic as cross-market coverage', () => {
    expect(classifyCoverageDirection('north', 'north').supported).toBe(false)
    expect(classifyCoverageDirection('south', 'south').code).toBe(
      'SAME_MARKET_NOT_CROSS_COVERAGE',
    )
  })

  it('does not silently apply domestic rules to international traffic', () => {
    expect(classifyCoverageDirection('south', 'international').code).toBe(
      'INTERNATIONAL_DIRECTION_REQUIRES_POLICY',
    )
  })
})
