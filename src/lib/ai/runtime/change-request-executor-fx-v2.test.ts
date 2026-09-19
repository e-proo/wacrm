import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('FX V2 approved change execution contract', () => {
  const source = readFileSync(
    new URL('./change-request-executor.ts', import.meta.url),
    'utf8',
  )
  const fxChangeExecutors = readFileSync(
    new URL('../../services/fx-v2/change-executors.ts', import.meta.url),
    'utf8',
  )
  const servicePlatformComposition = readFileSync(
    new URL('../../services/platform/composition.ts', import.meta.url),
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
  const legacyExecutors = readFileSync(
    new URL('../tools/executors.ts', import.meta.url),
    'utf8',
  )
  const currencyCrud = readFileSync(
    new URL('../../services/currencies/crud.ts', import.meta.url),
    'utf8',
  )

  it('delegates approved FX changes through the service-platform registry', () => {
    expect(source).toContain('tryExecuteCurrentChangeAction')
    expect(source).not.toContain("row.target_type === 'fx_rate_pair'")
    expect(source).not.toContain("row.target_type === 'fx_trade_request'")
    expect(servicePlatformComposition).toContain('FX_V2_DOMAIN')
    expect(servicePlatformComposition).toContain('FX_V2_RUNTIME')
    expect(servicePlatformComposition).toContain('CURRENT_CHANGE_EXECUTOR_REGISTRY')
  })

  it('publishes approved pair changes through the deterministic FX V2 domain executor', () => {
    expect(fxChangeExecutors).toContain('publishFxRateVersion({')
    expect(fxChangeExecutors).toContain("source: 'admin_agent'")
    expect(fxChangeExecutors).toContain('sourceChangeRequestId: change.id')
    expect(fxChangeExecutors).toContain(
      'expectedLockVersion: Number(payload.expected_lock_version)',
    )
    expect(fxChangeExecutors).toContain("operation: 'publish_fx_v2_rate_version'")
  })

  it('executes approved trade decisions from pending_admin only', () => {
    expect(fxChangeExecutors).toContain("payload.expected_status !== 'pending_admin'")
    expect(fxChangeExecutors).toContain('decideFxTradeRequest({')
    expect(fxChangeExecutors).toContain("expectedStatus: 'pending_admin'")
    expect(fxChangeExecutors).toContain('changeRequestId: change.id')
    expect(fxChangeExecutors).toContain("operation: 'decide_fx_v2_trade_request'")
  })

  it('contains no executable legacy rate-book change paths', () => {
    expect(source).not.toContain("row.target_type === 'rate_book_version'")
    expect(source).not.toContain('apply_exchange_rate_pair_change')
    expect(source).not.toContain('publishExchangeRateVersion')
    expect(fxChangeExecutors).not.toContain('apply_exchange_rate_pair_change')
    expect(fxChangeExecutors).not.toContain('publishExchangeRateVersion')
  })

  it('contains no legacy FX handoff/domain service implementation', () => {
    expect(businessHandoff).not.toContain('executeExchangeRateRecordTradeRequest')
    expect(businessHandoff).not.toContain('executeExchangeRateAdminListBooks')
    expect(businessHandoff).not.toContain('executeExchangeRateProposePairChange')
    expect(businessHandoff).not.toContain('exchange_rate_books')
    expect(domainServices).not.toContain('getCurrentExchangeRate')
    expect(domainServices).not.toContain('publishExchangeRateVersion')
    expect(domainServices).not.toContain('exchange_rate_books')
    expect(legacyExecutors).not.toContain('getCurrentExchangeRate')
    expect(currencyCrud).not.toContain(".from('exchange_rate_books')")
    expect(currencyCrud).not.toContain(".from('exchange_rates')")
  })

  it('removes the obsolete legacy FX HTTP and dashboard surface', () => {
    expect(existsSync(new URL('../../../app/api/exchange-rate-books/route.ts', import.meta.url))).toBe(false)
    expect(existsSync(new URL('../../../app/api/exchange-rate-books/[id]/publish/route.ts', import.meta.url))).toBe(false)
    expect(existsSync(new URL('../../../app/api/exchange-rate-books/[id]/versions/route.ts', import.meta.url))).toBe(false)
    expect(existsSync(new URL('../../../app/api/exchange-rate-history/route.ts', import.meta.url))).toBe(false)
    expect(existsSync(new URL('../../../app/api/exchange-rates/current/route.ts', import.meta.url))).toBe(false)
    expect(existsSync(new URL('../../../components/services/exchange-rate-books-panel.tsx', import.meta.url))).toBe(false)
  })

  it('keeps non-FX customer coverage handoffs intact', () => {
    expect(businessHandoff).toContain('executeCoverageProposeOfferIntegrated')
    expect(businessHandoff).toContain('executeCoverageProposeRequest')
  })

  it('registers only pair-centric FX V2 model tool executors', () => {
    expect(executorRegistry).toContain("add('exchange_rates.get_current', 1")
    expect(executorRegistry).toContain("add('exchange_rates.record_trade_request', 2")
    expect(executorRegistry).toContain("add('exchange_rates.admin_list_pairs', 1")
    expect(executorRegistry).toContain("add('exchange_rates.propose_pair_change', 2")
    expect(executorRegistry).not.toContain('admin_list_books')
    expect(executorRegistry).not.toContain("record_trade_request', 1")
    expect(executorRegistry).not.toContain("propose_pair_change', 1")
  })
})
