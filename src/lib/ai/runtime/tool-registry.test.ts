import { describe, it, expect } from 'vitest'
import {
  listRegisteredTools,
  getRegisteredTool,
  isGrantAllowed,
  renderToolCatalog,
} from './tool-registry'

describe('tool registry — repaired platform contract', () => {
  it('registers exactly the current 21 platform tools', () => {
    const keys = listRegisteredTools().map((tool) => tool.key).sort()
    expect(keys).toEqual(
      [
        'change_requests.list_pending',
        'coverage.admin_list_offers',
        'coverage.admin_list_requests',
        'coverage.check_availability',
        'coverage.find_offers',
        'coverage.get_rates',
        'coverage.propose_offer',
        'coverage.propose_request',
        'exchange_rates.admin_list_books',
        'exchange_rates.get_current',
        'exchange_rates.propose_pair_change',
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
      ].sort(),
    )
  })

  it('read grants remain read-risk and read-only', () => {
    for (const tool of listRegisteredTools()) {
      if (!tool.grantPermissions.includes('read')) continue
      expect(tool.risk).toBe('read')
      expect(tool.grantPermissions).toEqual(['read'])
      expect(isGrantAllowed(tool, 'execute')).toBe(false)
    }
  })

  it('proposal tools are proposal-only and never model-executable', () => {
    const proposalTools = listRegisteredTools().filter((tool) =>
      tool.grantPermissions.includes('propose'),
    )
    expect(proposalTools.length).toBeGreaterThan(0)
    for (const tool of proposalTools) {
      expect(tool.grantPermissions).toEqual(['propose'])
      expect(tool.risk).not.toBe('read')
      expect(isGrantAllowed(tool, 'read')).toBe(false)
      expect(isGrantAllowed(tool, 'execute')).toBe(false)
    }
  })

  it('isGrantAllowed returns false for non-listed permissions', () => {
    const services = getRegisteredTool('services.search')
    expect(services).not.toBeNull()
    if (services) {
      expect(isGrantAllowed(services, 'read')).toBe(true)
      expect(isGrantAllowed(services, 'propose')).toBe(false)
      expect(isGrantAllowed(services, 'execute')).toBe(false)
    }
  })

  it('returns null for unknown tools (DENY BY DEFAULT)', () => {
    expect(getRegisteredTool('does.not.exist')).toBeNull()
    expect(getRegisteredTool('execute_in_arbitrary_sql')).toBeNull()
  })

  it('renderToolCatalog surfaces exactly the granted, registered tools', () => {
    const catalog = renderToolCatalog([
      { tool_key: 'coverage.get_rates', permission: 'read' },
      { tool_key: 'intents.record', permission: 'propose' },
    ])
    expect(catalog).toContain('coverage.get_rates (read)')
    expect(catalog).toContain('intents.record (propose)')
    expect(catalog).toContain('args: {')
  })

  it('renderToolCatalog skips stale grant rows for unregistered tools', () => {
    const catalog = renderToolCatalog([
      { tool_key: 'legacy.removed_tool', permission: 'read' },
    ])
    expect(catalog).toBe('')
  })
})
