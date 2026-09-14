import { describe, it, expect } from 'vitest'
import {
  listRegisteredTools,
  getRegisteredTool,
  isGrantAllowed,
  renderToolCatalog,
} from './tool-registry'

// Phase 3: registry + the 5 read-only tools it ships.

describe('tool registry (Phase 3)', () => {
  it('registers exactly the 11 documented tools', () => {
    const tools = listRegisteredTools()
    const keys = tools.map((t) => t.key).sort()
    expect(keys).toEqual(
      [
        'coverage.check_availability',
        'coverage.find_offers',
        'coverage.get_rates',
        'coverage.propose_offer',
        'exchange_rates.get_current',
        'intents.record',
        'intents.search',
        'pricing.calculate_quote',
        'services.get',
        'services.match_request',
        'services.search',
      ].sort(),
    )
  })

  it('every read tool is risk=read and grants only `read`', () => {
    for (const t of listRegisteredTools()) {
      if (t.key === 'intents.record' || t.key === 'coverage.propose_offer') continue
      expect(t.risk).toBe('read')
      expect(t.grantPermissions).toEqual(['read'])
    }
  })

  it('propose-class tools cannot be self-executed by the model', () => {
    for (const key of ['intents.record', 'coverage.propose_offer']) {
      const tool = getRegisteredTool(key)
      expect(tool).not.toBeNull()
      if (tool) {
        expect(tool.grantPermissions).toEqual(['propose'])
        expect(isGrantAllowed(tool, 'read')).toBe(false)
        expect(isGrantAllowed(tool, 'execute')).toBe(false)
      }
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
    // Compact argument hint so the model can emit the call.
    expect(catalog).toContain('args: {')
  })

  it('renderToolCatalog skips stale grant rows for unregistered tools', () => {
    const catalog = renderToolCatalog([
      { tool_key: 'legacy.removed_tool', permission: 'read' },
    ])
    expect(catalog).toBe('')
  })
})
