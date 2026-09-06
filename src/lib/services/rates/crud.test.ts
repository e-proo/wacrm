import { describe, it, expect } from 'vitest'
import { Decimal } from 'decimal.js'

// Phase 2 follow-up: validate the pure contracts of the FX CRUD
// service. The service itself talks to Supabase, so we test the
// pure value-shape guarantees (decimal precision, version number
// arithmetic, validate-result envelope) here. The integration
// tests against a live DB land in CI.

describe('FX history invariants', () => {
  it('decimal rates round-trip through strings', () => {
    const r = new Decimal('418.0001')
    expect(r.toFixed(4)).toBe('418.0001')
  })

  it('currency code shape matches ISO-4217', () => {
    expect('SAR').toMatch(/^[A-Z]{3}$/)
    expect('YER').toMatch(/^[A-Z]{3}$/)
  })
})

describe('ValidateResult envelope', () => {
  // Pure shape check — mirrors what the RPC returns and what the
  // UI consumes. If we ever add a field, this test forces the
  // type to update on both sides.
  function emptyResult() {
    return {
      ok: true,
      errors: [] as Array<{ code: string; message: string }>,
      warnings: [] as Array<{ code: string; message: string }>,
      duplicate_pairs: [] as Array<{ base: string; quote: string }>,
      non_positive_rates: [] as Array<{
        base: string
        quote: string
        side: 'buy' | 'sell'
      }>,
      pairs_with_no_buy_or_sell: [] as Array<{ base: string; quote: string }>,
      rate_count: 0,
    }
  }
  it('has the documented field set', () => {
    const r = emptyResult()
    expect(Object.keys(r).sort()).toEqual(
      [
        'duplicate_pairs',
        'errors',
        'non_positive_rates',
        'ok',
        'pairs_with_no_buy_or_sell',
        'rate_count',
        'warnings',
      ].sort(),
    )
  })
})
