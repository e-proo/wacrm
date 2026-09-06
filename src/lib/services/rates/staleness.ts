// ============================================================
// Staleness check for published exchange rates.
//
// Phase 2 §8.4: a published rate version is considered stale when
// `now` is past `effective_at + stale_after_seconds` OR past
// `expires_at`. The UI surfaces a "still current?" badge; the
// runtime quote path REFUSES to return a `current` status on a
// stale version (returns `unavailable_stale` instead).
// ============================================================

export interface RateVersionTimestamps {
  effective_at: string | null
  expires_at: string | null
  published_at: string | null
  stale_after_seconds: number
}

export interface StalenessResult {
  isStale: boolean
  reason: 'not_yet_effective' | 'expired' | 'no_published_at' | null
  /** Seconds remaining until the version goes stale. Negative = already stale. */
  secondsUntilStale: number | null
}

export function evaluateStaleness(
  v: RateVersionTimestamps,
  now: Date = new Date(),
): StalenessResult {
  if (!v.published_at) {
    return { isStale: true, reason: 'no_published_at', secondsUntilStale: null }
  }

  const effectiveAt = v.effective_at
    ? Date.parse(v.effective_at)
    : Date.parse(v.published_at)
  const expiresAt = v.expires_at ? Date.parse(v.expires_at) : null
  const nowMs = now.getTime()

  if (effectiveAt > nowMs) {
    return {
      isStale: true,
      reason: 'not_yet_effective',
      secondsUntilStale: null,
    }
  }
  if (expiresAt !== null && expiresAt <= nowMs) {
    return { isStale: true, reason: 'expired', secondsUntilStale: null }
  }
  const staleAfterMs = v.stale_after_seconds * 1000
  const staleAtMs = effectiveAt + staleAfterMs
  const secondsUntilStale = Math.round((staleAtMs - nowMs) / 1000)
  return {
    isStale: staleAtMs <= nowMs,
    reason: null,
    secondsUntilStale,
  }
}
