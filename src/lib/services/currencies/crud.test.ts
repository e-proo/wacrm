import { describe, it, expect } from 'vitest'
import { DEFAULT_CURRENCIES } from './crud'

// Phase 2 completion: pure-shape guarantees for the currency
// catalog. The service itself talks to Supabase; these tests
// cover only the invariants the migration + reference data
// rely on.

describe('DEFAULT_CURRENCIES', () => {
  it('contains exactly the 4 documented currencies', () => {
    expect(DEFAULT_CURRENCIES.length).toBe(4)
  })

  it('every code is uppercase letters with optional underscores', () => {
    for (const c of DEFAULT_CURRENCIES) {
      expect(c.code).toMatch(/^[A-Z_]+$/)
      expect(c.code.length).toBeGreaterThanOrEqual(3)
      expect(c.code.length).toBeLessThanOrEqual(8)
    }
  })

  it('includes SAR, USD, YER, YER_OLD', () => {
    const codes = new Set(DEFAULT_CURRENCIES.map((c) => c.code))
    expect(codes.has('SAR')).toBe(true)
    expect(codes.has('USD')).toBe(true)
    expect(codes.has('YER')).toBe(true)
    expect(codes.has('YER_OLD')).toBe(true)
  })

  it('YER_OLD is marked as historical; the others as iso_4217', () => {
    const byCode = new Map(DEFAULT_CURRENCIES.map((c) => [c.code, c]))
    expect(byCode.get('YER_OLD')?.kind).toBe('historical')
    expect(byCode.get('SAR')?.kind).toBe('iso_4217')
    expect(byCode.get('USD')?.kind).toBe('iso_4217')
    expect(byCode.get('YER')?.kind).toBe('iso_4217')
  })

  it('every currency has a 2-decimal default', () => {
    for (const c of DEFAULT_CURRENCIES) {
      expect(c.decimalDigits).toBe(2)
    }
  })

  it('codes are unique within the default set', () => {
    const codes = DEFAULT_CURRENCIES.map((c) => c.code)
    expect(new Set(codes).size).toBe(codes.length)
  })
})

describe('code pattern validation', () => {
  const CODE_PATTERN = /^[A-Z_]{3,8}$/

  it('accepts SAR, USD, EUR, YER_OLD', () => {
    expect(CODE_PATTERN.test('SAR')).toBe(true)
    expect(CODE_PATTERN.test('USD')).toBe(true)
    expect(CODE_PATTERN.test('EUR')).toBe(true)
    // Underscore is allowed for historical codes like YER_OLD.
    expect(CODE_PATTERN.test('YER_OLD')).toBe(true)
  })

  it('rejects mixed-case and too-short codes', () => {
    expect(CODE_PATTERN.test('sar')).toBe(false)
    expect(CODE_PATTERN.test('US')).toBe(false)
  })

  it('accepts 8-letter codes (the maximum width)', () => {
    expect(CODE_PATTERN.test('USDOLLAR')).toBe(true)
  })

  it('rejects 9-letter codes (over the max)', () => {
    expect(CODE_PATTERN.test('USDOLLARX')).toBe(false)
  })

  it('rejects non-letter non-underscore characters', () => {
    expect(CODE_PATTERN.test('SAR-OLD')).toBe(false)
    expect(CODE_PATTERN.test('SAR1')).toBe(false)
  })
})
