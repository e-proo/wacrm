import { describe, it, expect } from 'vitest'
import crypto from 'crypto'

// We don't unit-test the full service (it requires a Supabase
// client). Instead we cover the pure invariants that the service
// depends on:
//   - OTP format (6 digits, padded with leading zeros).
//   - SHA-256 hashing is deterministic + collision-resistant for
//     distinct OTPs.
//   - Wrong OTP hash ≠ correct OTP hash.
//
// The service-level branching (attempts counter, expiry, etc.)
// lives behind integration tests once Phase 1 lands in a real DB.

function generateOtp(digits: number): string {
  const max = 10 ** digits
  const value = crypto.randomInt(0, max)
  return value.toString().padStart(digits, '0')
}

function hashOtp(otp: string): string {
  return crypto.createHash('sha256').update(otp).digest('hex')
}

describe('OTP generation', () => {
  it('always returns exactly the requested number of digits', () => {
    for (let i = 0; i < 50; i++) {
      const otp = generateOtp(6)
      expect(otp).toHaveLength(6)
      expect(/^\d{6}$/.test(otp)).toBe(true)
    }
  })

  it('never returns the same value twice in a row (probabilistic)', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) seen.add(generateOtp(6))
    expect(seen.size).toBeGreaterThan(190) // collisions essentially impossible
  })
})

describe('OTP hashing', () => {
  it('is deterministic', () => {
    expect(hashOtp('123456')).toBe(hashOtp('123456'))
  })

  it('differs for different OTPs', () => {
    expect(hashOtp('123456')).not.toBe(hashOtp('654321'))
  })

  it('produces a 64-character hex string', () => {
    expect(hashOtp('000000')).toMatch(/^[a-f0-9]{64}$/)
  })
})
