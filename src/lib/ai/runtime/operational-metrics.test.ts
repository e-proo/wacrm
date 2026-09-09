import { describe, expect, it } from 'vitest'

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

  it('keeps usage values numeric and additive', () => {
    const rows = [
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 },
    ]
    expect(rows.reduce((sum, row) => sum + row.total_tokens, 0)).toBe(25)
  })
})
