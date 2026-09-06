import { describe, it, expect } from 'vitest'
import { calculateQuote, type PricingRuleShape } from './engine'

const baseRule = (
  over: Partial<PricingRuleShape> & { id?: string; kind?: PricingRuleShape['kind'] },
): PricingRuleShape => ({
  id: over.id ?? 'rule-1',
  kind: over.kind ?? 'fixed',
  feeCurrency: over.feeCurrency ?? 'YER',
  inputCurrency: over.inputCurrency ?? 'YER',
  minimumFee: over.minimumFee ?? null,
  maximumFee: over.maximumFee ?? null,
  roundingMode: over.roundingMode ?? null,
  formulaConfig: over.formulaConfig ?? {},
})

describe('calculateQuote - fixed', () => {
  it('returns the rule amount verbatim', () => {
    const q = calculateQuote(
      baseRule({ kind: 'fixed', formulaConfig: { amount: '60' } }),
      { amount: '10000', currency: 'YER' },
    )
    expect(q.status).toBe('quoted')
    expect(q.feeAmount).toBe('60.00')
    expect(q.feeCurrency).toBe('YER')
  })
})

describe('calculateQuote - percentage', () => {
  it('computes percentage of amount', () => {
    const q = calculateQuote(
      baseRule({ kind: 'percentage', formulaConfig: { percentage: '2.5' } }),
      { amount: '10000', currency: 'YER' },
    )
    expect(q.feeAmount).toBe('250.00')
  })
})

describe('calculateQuote - per_unit (canonical 6/1000 example)', () => {
  it('matches the plan §7.3 example: 10000 at 6 per 1000 → 60', () => {
    const q = calculateQuote(
      baseRule({
        kind: 'per_unit',
        formulaConfig: {
          unit_size: '1000',
          rate_per_unit: '6',
          unit_rounding: 'proportional',
        },
      }),
      { amount: '10000', currency: 'YER' },
    )
    expect(q.feeAmount).toBe('60.00')
  })

  it('proportional 10500 → 63', () => {
    const q = calculateQuote(
      baseRule({
        kind: 'per_unit',
        formulaConfig: {
          unit_size: '1000',
          rate_per_unit: '6',
          unit_rounding: 'proportional',
        },
      }),
      { amount: '10500', currency: 'YER' },
    )
    expect(q.feeAmount).toBe('63.00')
  })

  it('ceil_started_unit 10500 → 66', () => {
    const q = calculateQuote(
      baseRule({
        kind: 'per_unit',
        formulaConfig: {
          unit_size: '1000',
          rate_per_unit: '6',
          unit_rounding: 'ceil_started_unit',
        },
      }),
      { amount: '10500', currency: 'YER' },
    )
    expect(q.feeAmount).toBe('66.00')
  })

  it('floor_complete_unit 10500 → 60', () => {
    const q = calculateQuote(
      baseRule({
        kind: 'per_unit',
        formulaConfig: {
          unit_size: '1000',
          rate_per_unit: '6',
          unit_rounding: 'floor_complete_unit',
        },
      }),
      { amount: '10500', currency: 'YER' },
    )
    expect(q.feeAmount).toBe('60.00')
  })

  it('nearest_unit 10500 → 66 (HALF_UP at 0.5)', () => {
    const q = calculateQuote(
      baseRule({
        kind: 'per_unit',
        formulaConfig: {
          unit_size: '1000',
          rate_per_unit: '6',
          unit_rounding: 'nearest_unit',
        },
      }),
      { amount: '10500', currency: 'YER' },
    )
    expect(q.feeAmount).toBe('66.00')
  })
})

describe('calculateQuote - fixed_plus_percentage', () => {
  it('sums a fixed part and a percentage', () => {
    const q = calculateQuote(
      baseRule({
        kind: 'fixed_plus_percentage',
        formulaConfig: { fixed: '50', percentage: '1' },
      }),
      { amount: '10000', currency: 'YER' },
    )
    expect(q.feeAmount).toBe('150.00')
  })
})

describe('calculateQuote - tiered', () => {
  it('walks tiers and sums the per-tier fee', () => {
    const q = calculateQuote(
      baseRule({
        kind: 'tiered',
        formulaConfig: {
          tiers: [
            { up_to: '5000', rate_per_unit: '5', unit_size: '1000' },
            { up_to: '*', rate_per_unit: '3', unit_size: '1000' },
          ],
        },
      }),
      { amount: '12000', currency: 'YER' },
    )
    // Tier 1: 5000 / 1000 * 5 = 25
    // Tier 2: 7000 / 1000 * 3 = 21
    expect(q.feeAmount).toBe('46.00')
  })
})

describe('calculateQuote - fx_buy_sell', () => {
  it('uses sell_rate when side=sell', () => {
    const q = calculateQuote(
      baseRule({
        kind: 'fx_buy_sell',
        feeCurrency: 'YER',
        formulaConfig: {
          side: 'sell',
          buy_rate: '418',
          sell_rate: '420',
        },
      }),
      { amount: '100', currency: 'SAR' },
    )
    expect(q.feeAmount).toBe('42000.00')
    expect(q.feeCurrency).toBe('YER')
  })

  it('uses buy_rate when side=buy', () => {
    const q = calculateQuote(
      baseRule({
        kind: 'fx_buy_sell',
        feeCurrency: 'YER',
        formulaConfig: {
          side: 'buy',
          buy_rate: '418',
          sell_rate: '420',
        },
      }),
      { amount: '100', currency: 'SAR' },
    )
    expect(q.feeAmount).toBe('41800.00')
  })
})

describe('calculateQuote - manual_quote', () => {
  it('returns the special status with no numeric output', () => {
    const q = calculateQuote(
      baseRule({ kind: 'manual_quote' }),
      { amount: '1000', currency: 'YER' },
    )
    expect(q.status).toBe('manual_quote_required')
    expect(q.feeAmount).toBeNull()
  })
})

describe('calculateQuote - clamping', () => {
  it('clamps below the minimum_fee', () => {
    const q = calculateQuote(
      baseRule({
        kind: 'fixed',
        formulaConfig: { amount: '5' },
        minimumFee: '10',
      }),
      { amount: '1000', currency: 'YER' },
    )
    expect(q.feeAmount).toBe('10.00')
  })

  it('clamps above the maximum_fee', () => {
    const q = calculateQuote(
      baseRule({
        kind: 'fixed',
        formulaConfig: { amount: '5000' },
        maximumFee: '1000',
      }),
      { amount: '1000', currency: 'YER' },
    )
    expect(q.feeAmount).toBe('1000.00')
  })
})
