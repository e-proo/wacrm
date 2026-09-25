import { describe, expect, it } from 'vitest'
import { Decimal, decimalsEqual, formatDecimal, parseDecimal } from './decimal'

describe('shared decimal primitive', () => {
  it('preserves high precision decimal strings', () => {
    expect(parseDecimal('900719925474099312345.67')?.toFixed(2)).toBe('900719925474099312345.67')
  })
  it('enforces sign and zero validation', () => {
    expect(parseDecimal('-1')).toBeNull()
    expect(parseDecimal('0', { rejectZero: true })).toBeNull()
    expect(parseDecimal('-1', { allowNegative: true })?.toString()).toBe('-1')
  })
  it('uses one HALF_UP formatting contract', () => {
    expect(formatDecimal(new Decimal('10.555'), 2)).toBe('10.56')
    expect(formatDecimal('0.0001', 8)).toBe('0.00010000')
  })
  it('supports tolerance comparisons', () => {
    expect(decimalsEqual('100.0001', '100')).toBe(true)
    expect(decimalsEqual('100.5', '100')).toBe(false)
  })
})
