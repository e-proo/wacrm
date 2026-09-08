import { describe, it, expect } from 'vitest'
import {
  listRegisteredTools,
  getRegisteredTool,
  isGrantAllowed,
} from './tool-registry'

// Phase 3: registry + the 5 read-only tools it ships.

describe('tool registry (Phase 3)', () => {
  it('registers exactly the 5 read-only tools from plan §4.3', () => {
    const tools = listRegisteredTools()
    const keys = tools.map((t) => t.key).sort()
    expect(keys).toEqual(
      [
        'coverage.check_availability',
        'exchange_rates.get_current',
        'pricing.calculate_quote',
        'services.get',
        'services.search',
      ].sort(),
    )
  })

  it('every tool is risk=read and grants only `read`', () => {
    for (const t of listRegisteredTools()) {
      expect(t.risk).toBe('read')
      expect(t.grantPermissions).toEqual(['read'])
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
})
