import { describe, expect, it } from 'vitest'
import { normalizeIdempotencyKey } from './idempotency'

describe('normalizeIdempotencyKey', () => {
  it('trims valid keys without changing their identity', () => {
    expect(normalizeIdempotencyKey('  fx-trade:abc123  ')).toBe('fx-trade:abc123')
  })

  it('rejects keys shorter than the shared minimum', () => {
    expect(normalizeIdempotencyKey('short')).toBeNull()
  })

  it('rejects keys beyond the outbox-compatible maximum', () => {
    expect(normalizeIdempotencyKey('x'.repeat(501))).toBeNull()
  })

  it('allows callers to narrow the accepted length contract', () => {
    expect(normalizeIdempotencyKey('abcd', { minLength: 4, maxLength: 4 })).toBe('abcd')
    expect(normalizeIdempotencyKey('abc', { minLength: 4, maxLength: 4 })).toBeNull()
  })
})
