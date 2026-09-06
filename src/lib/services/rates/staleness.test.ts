import { describe, it, expect } from 'vitest'
import { evaluateStaleness } from './staleness'

describe('evaluateStaleness', () => {
  const base = {
    effective_at: '2026-09-06T10:00:00Z',
    expires_at: null as string | null,
    published_at: '2026-09-06T10:00:00Z',
    stale_after_seconds: 1800,
  }
  const now = new Date('2026-09-06T10:15:00Z')

  it('returns not-stale within the window', () => {
    const r = evaluateStaleness(base, now)
    expect(r.isStale).toBe(false)
    expect(r.secondsUntilStale).toBeGreaterThan(0)
  })

  it('returns stale past the window', () => {
    const past = new Date('2026-09-06T10:31:00Z')
    const r = evaluateStaleness(base, past)
    expect(r.isStale).toBe(true)
    expect(r.secondsUntilStale).toBeLessThan(0)
  })

  it('returns stale when expires_at is in the past', () => {
    const r = evaluateStaleness(
      { ...base, expires_at: '2026-09-06T10:10:00Z' },
      now,
    )
    expect(r.isStale).toBe(true)
    expect(r.reason).toBe('expired')
  })

  it('returns stale when not yet effective', () => {
    const future = new Date('2026-09-06T10:00:00Z')
    const r = evaluateStaleness(
      { ...base, effective_at: '2026-09-06T10:20:00Z' },
      future,
    )
    expect(r.isStale).toBe(true)
    expect(r.reason).toBe('not_yet_effective')
  })

  it('returns stale when there is no published_at', () => {
    const r = evaluateStaleness({ ...base, published_at: null }, now)
    expect(r.isStale).toBe(true)
    expect(r.reason).toBe('no_published_at')
  })
})
