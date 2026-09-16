import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('FX V2 approved change execution contract', () => {
  const source = readFileSync(
    new URL('./change-request-executor.ts', import.meta.url),
    'utf8',
  )

  it('publishes approved pair changes through the deterministic FX V2 service', () => {
    expect(source).toContain("row.target_type === 'fx_rate_pair'")
    expect(source).toContain('publishFxRateVersion({')
    expect(source).toContain("source: 'admin_agent'")
    expect(source).toContain('sourceChangeRequestId: row.id')
    expect(source).toContain('expectedLockVersion: Number(p.expected_lock_version)')
    expect(source).toContain("operation: 'publish_fx_v2_rate_version'")
  })

  it('executes approved trade decisions from pending_admin only', () => {
    expect(source).toContain("row.target_type === 'fx_trade_request'")
    expect(source).toContain("p.expected_status !== 'pending_admin'")
    expect(source).toContain('decideFxTradeRequest({')
    expect(source).toContain("expectedStatus: 'pending_admin'")
    expect(source).toContain('changeRequestId: row.id')
    expect(source).toContain("operation: 'decide_fx_v2_trade_request'")
  })
})
