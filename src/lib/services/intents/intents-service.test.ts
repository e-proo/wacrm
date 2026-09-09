import { describe, it, expect } from 'vitest'

// Pure invariants of the intents idempotency key: the same
// (contact, direction, hint) must always derive the same key so
// a replayed agent observation collapses into one row.

function deriveIntentKey(
  contactId: string,
  direction: 'offer' | 'request',
  serviceHint: string,
): string {
  return `intent:${contactId}:${direction}:${serviceHint.trim().toLowerCase().slice(0, 80)}`
}

describe('intent idempotency key', () => {
  it('stable for the same inputs regardless of hint whitespace/case', () => {
    const a = deriveIntentKey('c-1', 'request', 'Outward Remittance ')
    const b = deriveIntentKey('c-1', 'request', 'outward remittance')
    expect(a).toBe(b)
  })

  it('differs across direction', () => {
    expect(deriveIntentKey('c-1', 'offer', 'x')).not.toBe(deriveIntentKey('c-1', 'request', 'x'))
  })

  it('differs across contact', () => {
    expect(deriveIntentKey('c-1', 'request', 'x')).not.toBe(deriveIntentKey('c-2', 'request', 'x'))
  })

  it('caps the hint contribution at 80 chars (long hints still collide safely)', () => {
    const long1 = 'a'.repeat(100) + '1'
    const long2 = 'a'.repeat(100) + '2'
    // Same first 80 chars → same key. This is intentional: the
    // uniqueness boundary is the trimmed, lowercased PREFIX.
    expect(deriveIntentKey('c-1', 'request', long1)).toBe(deriveIntentKey('c-1', 'request', long2))
  })
})
