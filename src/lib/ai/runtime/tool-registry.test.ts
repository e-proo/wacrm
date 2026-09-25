import { describe, expect, it } from 'vitest'
import {
  getCurrentToolDefinition,
  listCurrentToolDefinitions,
} from '@/lib/ai/tools/platform/runtime-tool-compat'
import {
  getRegisteredTool,
  isGrantAllowed,
  listRegisteredTools,
  renderToolCatalog,
} from './tool-registry'

const ALL_CURRENT_KEYS = [
  'change_requests.list_pending',
  'coverage.admin_list_offers',
  'coverage.admin_list_requests',
  'coverage.check_availability',
  'coverage.find_offers',
  'coverage.get_rates',
  'coverage.propose_offer',
  'coverage.propose_request',
  'exchange_rates.admin_list_pairs',
  'exchange_rates.admin_list_trade_requests',
  'exchange_rates.get_current',
  'exchange_rates.propose_pair_change',
  'exchange_rates.propose_trade_decision',
  'exchange_rates.record_trade_request',
  'intents.propose_decision',
  'intents.record',
  'intents.search',
  'pricing.calculate_quote',
  'pricing_rules.propose_service_price',
  'services.get',
  'services.match_request',
  'services.propose_update',
  'services.search',
].sort()

describe('legacy tool registry contraction', () => {
  it('retains only domains that have not migrated to native manifests', () => {
    const keys = listRegisteredTools().map((tool) => tool.key).sort()
    expect(keys).toEqual(
      ['change_requests.list_pending'],
    )

    expect(getRegisteredTool('exchange_rates.get_current')).toBeNull()
    expect(getRegisteredTool('coverage.get_rates')).toBeNull()
    expect(getRegisteredTool('intents.record')).toBeNull()
    expect(getRegisteredTool('intents.search')).toBeNull()
    expect(getRegisteredTool('intents.propose_decision')).toBeNull()
    expect(getRegisteredTool('services.search')).toBeNull()
    expect(getRegisteredTool('services.get')).toBeNull()
    expect(getRegisteredTool('services.match_request')).toBeNull()
    expect(getRegisteredTool('services.propose_update')).toBeNull()
    expect(getRegisteredTool('pricing.calculate_quote')).toBeNull()
    expect(getRegisteredTool('pricing_rules.propose_service_price')).toBeNull()
  })

  it('preserves read/proposal permission invariants for remaining legacy tools', () => {
    for (const tool of listRegisteredTools()) {
      if (tool.grantPermissions.includes('read')) {
        expect(tool.risk).toBe('read')
        expect(tool.grantPermissions).toEqual(['read'])
      } else {
        expect(tool.grantPermissions).toEqual(['propose'])
        expect(tool.risk).not.toBe('read')
      }
      expect(isGrantAllowed(tool, 'execute')).toBe(false)
    }
  })

  it('keeps the legacy prompt catalog limited to legacy-owned tools', () => {
    const catalog = renderToolCatalog([
      { tool_key: 'change_requests.list_pending', permission: 'read' },
      { tool_key: 'services.get', permission: 'read' },
      { tool_key: 'pricing.calculate_quote', permission: 'read' },
    ])

    expect(catalog).toContain('change_requests.list_pending (read)')
    expect(catalog).not.toContain('services.get')
    expect(catalog).not.toContain('pricing.calculate_quote')
  })
})

describe('current platform tool compatibility projection', () => {
  it('preserves the complete 23-tool API/UI catalog after native contraction', () => {
    expect(listCurrentToolDefinitions().map((tool) => tool.key).sort()).toEqual(
      ALL_CURRENT_KEYS,
    )
  })

  it('projects native Coverage contracts without a central duplicate spec', () => {
    const rates = getCurrentToolDefinition('coverage.get_rates', 1)
    expect(rates?.version).toBe(1)
    expect(rates?.grantPermissions).toEqual(['read'])
    expect(rates?.argumentSchema).toHaveProperty('amount')
    expect(rates?.argumentSchema).toHaveProperty('currency')
    expect(rates?.argumentSchema).toHaveProperty('pay_region')
    expect(rates?.argumentSchema).toHaveProperty('receive_region')
    expect(rates?.argumentSchema.receive_method.values).toContain('networks')
    expect(rates?.description).toContain('PAY south + RECEIVE north')

    expect(getCurrentToolDefinition('coverage.find_offers', 2)?.version).toBe(2)
    expect(getCurrentToolDefinition('coverage.propose_offer', 2)?.version).toBe(2)
    expect(getCurrentToolDefinition('coverage.propose_request', 1)?.version).toBe(1)
  })

  it('projects native FX contracts and frozen optimistic-lock inputs', () => {
    const read = getCurrentToolDefinition('exchange_rates.get_current', 1)
    expect(read?.description).toContain('authoritative CURRENT FX V2 rate')
    expect(read?.returnSchema).toContain('rate_version_id')

    const record = getCurrentToolDefinition('exchange_rates.record_trade_request', 2)
    expect(record?.grantPermissions).toEqual(['propose'])
    expect(record?.argumentSchema.expected_rate_version_id?.required).toBe(true)
    expect(record?.returnSchema).toContain('trade_request')

    const change = getCurrentToolDefinition('exchange_rates.propose_pair_change', 2)
    expect(change?.argumentSchema.expected_lock_version?.required).toBe(true)
    expect(change?.argumentSchema.business_buy_rate?.required).toBe(true)
    expect(change?.argumentSchema.business_sell_rate?.required).toBe(true)

    const decision = getCurrentToolDefinition(
      'exchange_rates.propose_trade_decision',
      1,
    )
    expect(decision?.argumentSchema.decision.values).toEqual(['approve', 'reject'])
  })

  it('projects native Intents contracts without changing the historical provider/UI shape', () => {
    const record = getCurrentToolDefinition('intents.record', 1)
    expect(record?.description).toBe(
      "Record a general observation about a customer's need or offer — even for services NOT equipped yet. Optionally escalates to the trusted admin for a decision.",
    )
    expect(record?.grantPermissions).toEqual(['propose'])
    expect(record?.argumentSchema.direction.values).toEqual(['offer', 'request'])
    expect(record?.argumentSchema.escalate_to_admin).toMatchObject({
      required: false,
      description: 'True when the admin must decide before anything is promised.',
    })
    expect(record?.returnSchema).toBe(
      '{ intent_id, status, change_request?: { id, code, confirmation_code } }',
    )

    const search = getCurrentToolDefinition('intents.search', 1)
    expect(search?.grantPermissions).toEqual(['read'])
    expect(search?.argumentSchema.status.values).toContain('forwarded_to_admin')
    expect(search?.returnSchema).toBe(
      'Array<{ intent_id, contact_id, direction, service_hint, summary, status, attributes, created_at }>',
    )

    const decision = getCurrentToolDefinition('intents.propose_decision', 1)
    expect(decision?.grantPermissions).toEqual(['propose'])
    expect(decision?.argumentSchema.decision.values).toEqual([
      'fulfilled',
      'rejected',
      'matched',
      'clarifying',
    ])
    expect(decision?.returnSchema).toBe(
      '{ change_request: { id, code, confirmation_code, status } }',
    )
  })

  it('fails closed for unknown tools', () => {
    expect(getCurrentToolDefinition('does.not.exist')).toBeNull()
    expect(getCurrentToolDefinition('execute_in_arbitrary_sql')).toBeNull()
  })
})
