import { describe, expect, it } from 'vitest'
import {
  FxCalculationError,
  calculateFxTrade,
  effectiveRateForSide,
} from './engine'

describe('FX V2 direction semantics', () => {
  it('uses business sell rate when customer buys base currency', () => {
    const result = calculateFxTrade({
      side: 'customer_buy',
      amountBasis: 'base',
      requestedAmount: '1000',
      businessBuyRate: '425',
      businessSellRate: '428',
      baseDecimalDigits: 2,
      quoteDecimalDigits: 2,
    })

    expect(result.rateSide).toBe('business_sell')
    expect(result.effectiveRate).toBe('428.00000000')
    expect(result.baseAmount).toBe('1000.00')
    expect(result.quoteAmount).toBe('428000.00')
  })

  it('uses business buy rate when customer sells base currency', () => {
    const result = calculateFxTrade({
      side: 'customer_sell',
      amountBasis: 'base',
      requestedAmount: '1000',
      businessBuyRate: '425',
      businessSellRate: '428',
      baseDecimalDigits: 2,
      quoteDecimalDigits: 2,
    })

    expect(result.rateSide).toBe('business_buy')
    expect(result.effectiveRate).toBe('425.00000000')
    expect(result.quoteAmount).toBe('425000.00')
  })

  it('resolves the effective side directly', () => {
    expect(effectiveRateForSide('customer_buy', '10', '11').rate.toString()).toBe(
      '11',
    )
    expect(effectiveRateForSide('customer_sell', '10', '11').rate.toString()).toBe(
      '10',
    )
  })
})

describe('FX V2 amount basis and rounding', () => {
  it('converts a quote-denominated request back to base', () => {
    const result = calculateFxTrade({
      side: 'customer_buy',
      amountBasis: 'quote',
      requestedAmount: '428000',
      businessBuyRate: '425',
      businessSellRate: '428',
      baseDecimalDigits: 2,
      quoteDecimalDigits: 2,
    })

    expect(result.baseAmount).toBe('1000.00')
    expect(result.quoteAmount).toBe('428000.00')
  })

  it('rounds HALF_UP at currency boundaries', () => {
    const result = calculateFxTrade({
      side: 'customer_buy',
      amountBasis: 'base',
      requestedAmount: '1.005',
      businessBuyRate: '1',
      businessSellRate: '2.5',
      baseDecimalDigits: 2,
      quoteDecimalDigits: 0,
    })

    expect(result.baseAmount).toBe('1.01')
    expect(result.quoteAmount).toBe('3')
  })

  it('rejects amounts that round to zero', () => {
    expect(() =>
      calculateFxTrade({
        side: 'customer_buy',
        amountBasis: 'base',
        requestedAmount: '0.004',
        businessBuyRate: '425',
        businessSellRate: '428',
        baseDecimalDigits: 2,
        quoteDecimalDigits: 2,
      }),
    ).toThrowError(FxCalculationError)

    try {
      calculateFxTrade({
        side: 'customer_buy',
        amountBasis: 'base',
        requestedAmount: '0.004',
        businessBuyRate: '425',
        businessSellRate: '428',
        baseDecimalDigits: 2,
        quoteDecimalDigits: 2,
      })
    } catch (error) {
      expect((error as FxCalculationError).code).toBe('FX_AMOUNT_ROUNDS_TO_ZERO')
    }
  })

  it('rejects invalid decimal precision', () => {
    expect(() =>
      calculateFxTrade({
        side: 'customer_sell',
        amountBasis: 'base',
        requestedAmount: '10',
        businessBuyRate: '425',
        businessSellRate: '428',
        baseDecimalDigits: 9,
        quoteDecimalDigits: 2,
      }),
    ).toThrowError(/between 0 and 8/)
  })
})
