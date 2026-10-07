import { describe, expect, it } from 'vitest'
import {
  getCurrentToolDefinition,
  listBuilderToolDefinitions,
  listCurrentToolDefinitions,
} from './runtime-tool-compat'

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

describe('current platform tool compatibility projection', () => {
  it('preserves the complete 23-tool API/UI catalog after native contraction', () => {
    expect(listCurrentToolDefinitions().map((tool) => tool.key).sort()).toEqual(
      ALL_CURRENT_KEYS,
    )
  })

  it('projects native contracts without a legacy registry or bridge', () => {
    const pending = getCurrentToolDefinition('change_requests.list_pending', 1)
    expect(pending?.grantPermissions).toEqual(['read'])
    expect(pending?.category).toBe('changes')
    expect(pending?.argumentSchema.limit?.required).toBe(false)
    expect(pending?.returnSchema).toContain('proposed_payload')

    expect(getCurrentToolDefinition('coverage.get_rates', 1)?.grantPermissions).toEqual(['read'])
    expect(getCurrentToolDefinition('exchange_rates.get_current', 1)?.returnSchema).toContain('rate_version_id')
    expect(getCurrentToolDefinition('intents.record', 1)?.grantPermissions).toEqual(['propose'])
  })

  it('fails closed for unknown tools', () => {
    expect(getCurrentToolDefinition('does.not.exist')).toBeNull()
    expect(getCurrentToolDefinition('execute_in_arbitrary_sql')).toBeNull()
  })
})

describe('builder tool compatibility projection', () => {
  it('never exposes execute grants to the builder', () => {
    const builderTools = listBuilderToolDefinitions()

    expect(builderTools.length).toBeGreaterThan(0)
    expect(
      builderTools.every((tool) =>
        tool.grantPermissions.every(
          (permission) => permission === 'read' || permission === 'propose',
        ),
      ),
    ).toBe(true)
  })

  it('is a safe subset of the current registry projection', () => {
    const currentKeys = new Set(
      listCurrentToolDefinitions().map((tool) => `${tool.key}@${tool.version}`),
    )
    for (const tool of listBuilderToolDefinitions()) {
      expect(currentKeys.has(`${tool.key}@${tool.version}`)).toBe(true)
    }
  })
})
