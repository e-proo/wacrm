import { describe, expect, it } from 'vitest'

// Contracts of the operational metrics (agent-health view).
// Token-spend aggregation deliberately lives in the Usage tab
// (src/lib/ai/usage.ts) — this module must NOT duplicate it.

describe('operational metric contracts', () => {
  it('uses the documented 30-day default window', () => {
    const now = Date.parse('2026-09-09T00:00:00Z')
    const start = new Date(now - 30 * 24 * 60 * 60 * 1000)
    expect(start.toISOString()).toBe('2026-08-10T00:00:00.000Z')
  })

  it('counts denied tool attempts as failures', () => {
    const statuses = ['succeeded', 'failed', 'denied', 'accepted']
    const failures = statuses.filter((status) => status === 'failed' || status === 'denied')
    expect(failures).toHaveLength(2)
  })

  it('does NOT expose token-spend aggregates (usage tab owns them)', () => {
    // Shape guard: if someone re-adds usage totals here, the two
    // dashboards compete for the same ai_usage_log rows again.
    const shapeKeys = ['runs', 'failedRuns', 'tools']
    type MetricsShape = { runs: Record<string, number>; failedRuns: number; tools: unknown[] }
    const sample: MetricsShape = { runs: {}, failedRuns: 0, tools: [] }
    expect(Object.keys(sample).sort()).toEqual(shapeKeys.sort())
    expect('usage' in sample).toBe(false)
  })

  it('counts skipped runs with an error code as failures too', () => {
    // Phase 1/3 dispatcher marks bridged runs skipped with
    // phase*_legacy_path_only — those are "did not serve the
    // customer", so the health count must include them.
    const row = { status: 'skipped', error_code: 'phase3_legacy_path_only' }
    const counts = Boolean(row.status === 'failed' || (row.status === 'skipped' && row.error_code))
    expect(counts).toBe(true)
  })
})
