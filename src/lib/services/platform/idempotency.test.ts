import { describe, expect, it } from 'vitest'
import { normalizeIdempotencyKey } from './idempotency'

describe('normalizeIdempotencyKey', () => {
  it('preserves raw identity by default and trims only when explicitly requested', () => {
    expect(normalizeIdempotencyKey('  fx-trade:abc123  ')).toBe('  fx-trade:abc123  ')
    expect(normalizeIdempotencyKey('  fx-trade:abc123  ', { trim: true })).toBe(
      'fx-trade:abc123',
    )
  })

  it('rejects keys shorter than the shared minimum', () => {
    expect(normalizeIdempotencyKey('short')).toBeNull()
  })

  it('does not impose a new maximum unless the caller explicitly requests one', () => {
    expect(normalizeIdempotencyKey('x'.repeat(501))).toBe('x'.repeat(501))
    expect(normalizeIdempotencyKey('x'.repeat(5), { maxLength: 4 })).toBeNull()
  })

  it('allows callers to narrow the accepted length contract', () => {
    expect(normalizeIdempotencyKey('abcd', { minLength: 4, maxLength: 4 })).toBe('abcd')
    expect(normalizeIdempotencyKey('abc', { minLength: 4, maxLength: 4 })).toBeNull()
  })
})
