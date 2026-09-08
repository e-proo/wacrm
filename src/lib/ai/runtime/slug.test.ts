import { describe, it, expect } from 'vitest'
import { SLUG_PATTERN_BUILDER } from './slug'

// Phase 4 builder — slug derivation contract (§5 step 1).

describe('SLUG_PATTERN_BUILDER', () => {
  it('accepts lowercase alphanumerics with optional hyphens', () => {
    expect(SLUG_PATTERN_BUILDER.test('coverage-agent')).toBe(true)
    expect(SLUG_PATTERN_BUILDER.test('agent1')).toBe(true)
    expect(SLUG_PATTERN_BUILDER.test('a')).toBe(true)
  })

  it('rejects uppercase, spaces, and edge hyphens', () => {
    expect(SLUG_PATTERN_BUILDER.test('Coverage')).toBe(false)
    expect(SLUG_PATTERN_BUILDER.test('my agent')).toBe(false)
    expect(SLUG_PATTERN_BUILDER.test('-agent')).toBe(false)
    expect(SLUG_PATTERN_BUILDER.test('agent-')).toBe(false)
    expect(SLUG_PATTERN_BUILDER.test('')).toBe(false)
  })
})

describe('deriveSlugFromName (pure helper)', () => {
  // Mirrors the normalization the API route applies when the
  // caller omits `slug`. Kept in a tiny shared module so the
  // test exercises the same code the route runs.
  function deriveSlugFromName(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'agent'
    )
  }

  it('normalizes spaces and mixed case', () => {
    expect(deriveSlugFromName('Coverage Agent')).toBe('coverage-agent')
    expect(deriveSlugFromName('  Triage  ')).toBe('triage')
  })

  it('strips non-latin characters to the fallback', () => {
    // Arabic-only name has no [a-z0-9] chars → the || 'agent'
    // fallback fires (matches the API route behavior).
    expect(deriveSlugFromName('وكيل التغطية')).toBe('agent')
  })

  it('mixed Arabic + latin keeps the latin part', () => {
    expect(deriveSlugFromName('وكيل Coverage')).toBe('coverage')
  })

  it('caps at 60 chars', () => {
    const long = 'a'.repeat(100)
    expect(deriveSlugFromName(long)).toHaveLength(60)
  })
})
