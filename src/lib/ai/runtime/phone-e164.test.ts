import { describe, it, expect } from 'vitest'
import { canonicalizeE164, e164Equals } from './phone-e164'

describe('canonicalizeE164', () => {
  it('returns null for empty / null / undefined', () => {
    expect(canonicalizeE164(null)).toBeNull()
    expect(canonicalizeE164(undefined)).toBeNull()
    expect(canonicalizeE164('')).toBeNull()
  })

  it('strips whitespace, dashes, parentheses, and plus signs', () => {
    expect(canonicalizeE164('+1 (415) 555-2671')).toBe('14155552671')
    expect(canonicalizeE164(' 415-555-2671 ')).toBe('4155552671')
  })

  it('rejects too-short numbers', () => {
    expect(canonicalizeE164('123456')).toBeNull()
  })

  it('rejects too-long numbers (>15 digits)', () => {
    expect(canonicalizeE164('1234567890123456')).toBeNull()
  })

  it('rejects leading zero', () => {
    expect(canonicalizeE164('0123456789')).toBeNull()
  })

  it('accepts a normal international number', () => {
    expect(canonicalizeE164('+967777123456')).toBe('967777123456')
  })
})

describe('e164Equals', () => {
  it('matches two valid canonicalizations regardless of formatting', () => {
    expect(e164Equals('+1 (415) 555-2671', '14155552671')).toBe(true)
  })

  it('does not match invalid inputs (null vs value)', () => {
    expect(e164Equals(null, '14155552671')).toBe(false)
    expect(e164Equals('', '14155552671')).toBe(false)
  })

  it('does not match different numbers', () => {
    expect(e164Equals('+14155552671', '+14155552672')).toBe(false)
  })
})
