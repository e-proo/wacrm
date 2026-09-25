import { describe, expect, it } from 'vitest'
import { CURRENCY_CODE_PATTERN, isCurrencyCode, normalizeCurrencyCode } from './currency-code'

describe('shared currency-code primitive', () => {
  it('normalizes ISO and historical/local codes', () => {
    expect(normalizeCurrencyCode(' sar ')).toBe('SAR')
    expect(normalizeCurrencyCode(' yer_old ')).toBe('YER_OLD')
  })
  it('rejects malformed and out-of-range codes', () => {
    expect(normalizeCurrencyCode('US')).toBeNull()
    expect(normalizeCurrencyCode('SAR-OLD')).toBeNull()
    expect(normalizeCurrencyCode('USDOLLARX')).toBeNull()
    expect(isCurrencyCode('usd')).toBe(true)
    expect(isCurrencyCode('bad-code')).toBe(false)
  })
  it('keeps one regex contract', () => {
    expect(CURRENCY_CODE_PATTERN.test('USD')).toBe(true)
    expect(CURRENCY_CODE_PATTERN.test('YER_OLD')).toBe(true)
  })
})
