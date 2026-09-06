import { describe, it, expect } from 'vitest'
import { canonicalizeE164 } from './phone-e164'

// These cover the invariants that the backfill + trusted-admin
// services depend on. The full services need a live DB; the
// invariants here are what guarantees "no surprise" behavior at
// integration time.

describe('backfill / trusted-admin invariants', () => {
  it('strips non-digit noise before persisting an identity address', () => {
    expect(canonicalizeE164('+967 (777) 123-456')).toBe('967777123456')
  })

  it('treats "+" and spaces as formatting only', () => {
    expect(canonicalizeE164('+967 777 123 456')).toBe('967777123456')
    expect(canonicalizeE164('967777123456')).toBe('967777123456')
  })

  it('refuses a leading-zero number (E.164 first digit must be 1-9)', () => {
    expect(canonicalizeE164('0123456789')).toBeNull()
  })

  it('refuses numbers outside the 7-15 digit window', () => {
    expect(canonicalizeE164('123456')).toBeNull() // 6 digits
    expect(canonicalizeE164('1234567890123456')).toBeNull() // 16 digits
  })

  it('round-trips through E.164 cleanly', () => {
    // A canonicalized number canonicalizes to itself.
    const canonical = '967777123456'
    expect(canonicalizeE164(canonicalizeE164(canonical))).toBe(canonical)
  })
})
