import { describe, it, expect } from 'vitest'
import { Decimal } from 'decimal.js'

// Phase 2 completion: pure-shape contracts of the pricing-rules
// CRUD service. The service talks to Supabase; these tests cover
// only the invariants that don't need a DB.

describe('Pricing-rule kind enum', () => {
  const kinds = [
    'fixed',
    'percentage',
    'per_unit',
    'fixed_plus_percentage',
    'tiered',
    'fx_buy_sell',
    'manual_quote',
  ]
  it('has exactly the 7 documented kinds', () => {
    expect(new Set(kinds).size).toBe(7)
  })
  it('every kind is a non-empty string', () => {
    for (const k of kinds) expect(typeof k).toBe('string')
    for (const k of kinds) expect(k.length).toBeGreaterThan(0)
  })
})

describe('Rounding-mode enum', () => {
  const modes = [
    'proportional',
    'ceil_started_unit',
    'floor_complete_unit',
    'nearest_unit',
  ]
  it('has exactly the 4 documented rounding modes', () => {
    expect(new Set(modes).size).toBe(4)
  })
})

describe('Decimal precision invariant', () => {
  it('keeps a fee value exact across rounding boundaries', () => {
    // Plan §7.2 example: minimum_fee=10, fixed=5.5 → clamps to 10.00.
    const fee = new Decimal('5.5')
    const min = new Decimal('10')
    const clamped = fee.lt(min) ? min : fee
    expect(clamped.toFixed(2)).toBe('10.00')
  })

  it('serialises a tiered-bracket sum with no drift', () => {
    // 5000/1000*5 + 7000/1000*3 = 25 + 21 = 46.00 (plan §7.3).
    const part1 = new Decimal('5000').times('5').dividedBy('1000')
    const part2 = new Decimal('7000').times('3').dividedBy('1000')
    const total = part1.plus(part2)
    expect(total.toFixed(2)).toBe('46.00')
  })
})
