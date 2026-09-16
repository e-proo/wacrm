import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('FX V2 approved change execution contract', () => {
  const source = readFileSync(
    new URL('./change-request-executor.ts', import.meta.url),
    'utf8',
  )
  const businessHandoff = readFileSync(
    new URL('../tools/business-handoff.ts', import.meta.url),
    'utf8',
  )
  const domainServices = readFileSync(
    new URL('../../services/domain-services.ts', import.meta.url),
    'utf8',
  )
  const executorRegistry = readFileSync(
    new URL('../tools/platform/current-executor-registry.ts', import.meta.url),
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

  it('contains no executable legacy rate-book change paths', () => {
    expect(source).not.toContain("row.target_type === 'rate_book_version'")
    expect(source).not.toContain('apply_exchange_rate_pair_change')
    expect(source).not.toContain('publishExchangeRateVersion')
  })

  it('contains no legacy FX handoff/domain service implementation', () => {
    expect(businessHandoff).not.toContain('executeExchangeRateRecordTradeRequest')
    expect(businessHandoff).not.toContain('executeExchangeRateAdminListBooks')
    expect(businessHandoff).not.toContain('executeExchangeRateProposePairChange')
    expect(businessHandoff).not.toContain('exchange_rate_books')
    expect(domainServices).not.toContain('getCurrentExchangeRate')
    expect(domainServices).not.toContain('publishExchangeRateVersion')
    expect(domainServices).not.toContain('exchange_rate_books')
  })

  it('registers only pair-centric FX V2 executors', () => {
    expect(executorRegistry).toContain("add('exchange_rates.get_current', 1")
    expect(executorRegistry).toContain("add('exchange_rates.record_trade_request', 2")
    expect(executorRegistry).toContain("add('exchange_rates.admin_list_pairs', 1")
    expect(executorRegistry).toContain("add('exchange_rates.propose_pair_change', 2")
    expect(executorRegistry).not.toContain('admin_list_books')
    expect(executorRegistry).not.toContain("record_trade_request', 1")
    expect(executorRegistry).not.toContain("propose_pair_change', 1")
  })
})
