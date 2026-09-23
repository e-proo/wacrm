import { describe, it, expect } from 'vitest'
import { Decimal } from 'decimal.js'
import { decimalsEqual, formatDecimal, parseDecimal } from './decimal'

describe('parseDecimal', () => {
  it('parses integer strings', () => {
    expect(parseDecimal('10000')?.toString()).toBe('10000')
  })

  it('parses decimal strings', () => {
    expect(parseDecimal('10000.50')?.toString()).toBe('10000.5')
  })

  it('strips whitespace and group separators', () => {
    expect(parseDecimal(' 10 000.50 ')?.toString()).toBe('10000.5')
  })

  it('parses numbers', () => {
    expect(parseDecimal(1000)?.toString()).toBe('1000')
  })

  it('rejects non-numeric strings', () => {
    expect(parseDecimal('abc')).toBeNull()
    expect(parseDecimal('1000.50.0')).toBeNull()
    expect(parseDecimal('1,000.50')).toBeNull()
  })

  it('rejects empty / null / undefined', () => {
    expect(parseDecimal('')).toBeNull()
    expect(parseDecimal(null)).toBeNull()
    expect(parseDecimal(undefined)).toBeNull()
  })

  it('rejects negative when allowNegative is false', () => {
    expect(parseDecimal('-100')).toBeNull()
    expect(parseDecimal('100', { allowNegative: true })?.toString()).toBe('100')
    expect(parseDecimal('-100', { allowNegative: true })?.toString()).toBe('-100')
  })

  it('rejects zero when rejectZero is true', () => {
    expect(parseDecimal('0', { rejectZero: true })).toBeNull()
    expect(parseDecimal('0', { rejectZero: false })?.toString()).toBe('0')
    expect(parseDecimal('0.0', { rejectZero: true })).toBeNull()
  })

  it('preserves financial strings beyond JavaScript safe-integer precision', () => {
    expect(parseDecimal('900719925474099312345.67')?.toFixed(2)).toBe(
      '900719925474099312345.67',
    )
  })
})

describe('formatDecimal', () => {
  it('formats to fixed decimal places (default 2)', () => {
    expect(formatDecimal(new Decimal('10000.5'))).toBe('10000.50')
    expect(formatDecimal(new Decimal('10000.555'), 2)).toBe('10000.56')
    expect(formatDecimal(new Decimal('10000.554'), 2)).toBe('10000.55')
  })

  it('handles arbitrary precision', () => {
    expect(formatDecimal(new Decimal('10000.123456'), 4)).toBe('10000.1235')
    expect(formatDecimal(new Decimal('0.0001'), 8)).toBe('0.00010000')
  })

  it('accepts plain numbers + strings', () => {
    expect(formatDecimal(100)).toBe('100.00')
    expect(formatDecimal('100.5')).toBe('100.50')
  })
})

describe('decimalsEqual', () => {
  it('exact match', () => {
    expect(decimalsEqual('100.00', '100')).toBe(true)
  })

  it('tolerates 1-ulp drift', () => {
    expect(decimalsEqual('100.0001', '100')).toBe(true)
    expect(decimalsEqual('100.5', '100')).toBe(false)
  })
})
