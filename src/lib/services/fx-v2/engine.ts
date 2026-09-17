import { Decimal } from 'decimal.js'
import { parseDecimal } from '@/lib/services/pricing/decimal'

export type FxTradeSide = 'customer_buy' | 'customer_sell'
export type FxAmountBasis = 'base' | 'quote'

export class FxCalculationError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'FxCalculationError'
    this.code = code
  }
}

export interface CalculateFxTradeInput {
  side: FxTradeSide
  amountBasis: FxAmountBasis
  requestedAmount: string
  businessBuyRate: string
  businessSellRate: string
  baseDecimalDigits: number
  quoteDecimalDigits: number
}

export interface FxTradeCalculation {
  side: FxTradeSide
  amountBasis: FxAmountBasis
  requestedAmount: string
  effectiveRate: string
  rateSide: 'business_buy' | 'business_sell'
  baseAmount: string
  quoteAmount: string
}

function positiveDecimal(value: string, code: string, field: string): Decimal {
  const parsed = parseDecimal(value, { rejectZero: true })
  if (!parsed || parsed.isNegative()) {
    throw new FxCalculationError(code, `${field} must be a positive decimal.`)
  }
  return parsed
}

function assertDecimalDigits(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 8) {
    throw new FxCalculationError(
      'FX_INVALID_DECIMAL_DIGITS',
      `${field} must be an integer between 0 and 8.`,
    )
  }
}

export function effectiveRateForSide(
  side: FxTradeSide,
  businessBuyRate: string,
  businessSellRate: string,
): { rate: Decimal; rateSide: 'business_buy' | 'business_sell' } {
  const buy = positiveDecimal(
    businessBuyRate,
    'FX_INVALID_BUY_RATE',
    'businessBuyRate',
  )
  const sell = positiveDecimal(
    businessSellRate,
    'FX_INVALID_SELL_RATE',
    'businessSellRate',
  )

  if (side === 'customer_buy') {
    return { rate: sell, rateSide: 'business_sell' }
  }
  if (side === 'customer_sell') {
    return { rate: buy, rateSide: 'business_buy' }
  }
  throw new FxCalculationError('FX_INVALID_TRADE_SIDE', 'Unsupported FX trade side.')
}

/**
 * Pair convention: one BASE unit is worth `rate` QUOTE units.
 *
 * customer_buy  -> business sells BASE -> business_sell_rate
 * customer_sell -> business buys BASE  -> business_buy_rate
 *
 * HALF_UP rounding is applied only at currency boundaries using each
 * currency's configured decimal_digits. The stored rate itself keeps
 * the database's 8-decimal precision.
 */
export function calculateFxTrade(
  input: CalculateFxTradeInput,
): FxTradeCalculation {
  assertDecimalDigits(input.baseDecimalDigits, 'baseDecimalDigits')
  assertDecimalDigits(input.quoteDecimalDigits, 'quoteDecimalDigits')

  const requested = positiveDecimal(
    input.requestedAmount,
    'FX_INVALID_TRADE_AMOUNT',
    'requestedAmount',
  )
  const { rate, rateSide } = effectiveRateForSide(
    input.side,
    input.businessBuyRate,
    input.businessSellRate,
  )

  let baseAmount: Decimal
  let quoteAmount: Decimal

  if (input.amountBasis === 'base') {
    baseAmount = requested.toDecimalPlaces(
      input.baseDecimalDigits,
      Decimal.ROUND_HALF_UP,
    )
    quoteAmount = baseAmount
      .mul(rate)
      .toDecimalPlaces(input.quoteDecimalDigits, Decimal.ROUND_HALF_UP)
  } else if (input.amountBasis === 'quote') {
    quoteAmount = requested.toDecimalPlaces(
      input.quoteDecimalDigits,
      Decimal.ROUND_HALF_UP,
    )
    baseAmount = quoteAmount
      .div(rate)
      .toDecimalPlaces(input.baseDecimalDigits, Decimal.ROUND_HALF_UP)
  } else {
    throw new FxCalculationError(
      'FX_INVALID_AMOUNT_BASIS',
      'amountBasis must be base or quote.',
    )
  }

  if (baseAmount.lte(0) || quoteAmount.lte(0)) {
    throw new FxCalculationError(
      'FX_AMOUNT_ROUNDS_TO_ZERO',
      'The requested amount becomes zero after currency rounding.',
    )
  }

  return {
    side: input.side,
    amountBasis: input.amountBasis,
    requestedAmount: requested.toFixed(8),
    effectiveRate: rate.toFixed(8),
    rateSide,
    baseAmount: baseAmount.toFixed(input.baseDecimalDigits),
    quoteAmount: quoteAmount.toFixed(input.quoteDecimalDigits),
  }
}
