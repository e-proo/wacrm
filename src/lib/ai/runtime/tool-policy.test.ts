import { describe, expect, it } from 'vitest'
import { authorizeToolInvocation } from './tool-policy'
import type { ToolDefinition } from './tool-registry'

const tool: ToolDefinition = {
  key: 'services.get',
  version: 1,
  description: 'test',
  argumentSchema: { id_or_code: { type: 'string', description: 'id', required: true } },
  returnSchema: '{}',
  grantPermissions: ['read'],
  category: 'services',
  risk: 'read',
}
const features = { killSwitch: false, nativeToolsEnabled: true, proposalToolsEnabled: true }

describe('authorizeToolInvocation', () => {
  it('requires the trusted admin capability on admin plane', () => {
    const result = authorizeToolInvocation({
      tool,
      permission: 'read',
      args: { id_or_code: 'svc' },
      constraints: {},
      context: {
        plane: 'admin', channel: 'whatsapp', simulation: false,
        agentPurpose: 'admin_operations', trustedAdminIdentityId: 'id',
        trustedAdminCapabilities: [], features,
      },
    })
    expect(result).toMatchObject({ ok: false, code: 'ADMIN_CAPABILITY_DENIED' })
  })

  it('fails closed on an unenforced grant constraint', () => {
    const result = authorizeToolInvocation({
      tool,
      permission: 'read',
      args: { id_or_code: 'svc' },
      constraints: { magic_scope: ['x'] },
      context: {
        plane: 'customer', channel: 'whatsapp', simulation: false,
        agentPurpose: 'customer_support', trustedAdminIdentityId: null,
        trustedAdminCapabilities: [], features,
      },
    })
    expect(result).toMatchObject({ ok: false, code: 'GRANT_CONSTRAINT_UNSUPPORTED' })
  })

  it('prevents admin-operation agents from running on customer plane', () => {
    const result = authorizeToolInvocation({
      tool,
      permission: 'read',
      args: { id_or_code: 'svc' },
      constraints: {},
      context: {
        plane: 'customer', channel: 'whatsapp', simulation: false,
        agentPurpose: 'admin_operations', trustedAdminIdentityId: null,
        trustedAdminCapabilities: [], features,
      },
    })
    expect(result).toMatchObject({ ok: false, code: 'AGENT_PURPOSE_DENIED' })
  })

  it('allows customers to forward FX buy/sell requests but not change rates', () => {
    const tradeRequestTool: ToolDefinition = {
      key: 'exchange_rates.record_trade_request', version: 1, description: 'test',
      argumentSchema: {}, returnSchema: '{}', grantPermissions: ['propose'],
      category: 'rates', risk: 'medium',
    }
    const rateChangeTool: ToolDefinition = {
      key: 'exchange_rates.propose_pair_change', version: 1, description: 'test',
      argumentSchema: {}, returnSchema: '{}', grantPermissions: ['propose'],
      category: 'rates', risk: 'high',
    }
    const context = {
      plane: 'customer' as const, channel: 'whatsapp' as const, simulation: false,
      agentPurpose: 'customer_support' as const, trustedAdminIdentityId: null,
      trustedAdminCapabilities: [], features,
    }
    expect(authorizeToolInvocation({
      tool: tradeRequestTool, permission: 'propose', args: {}, constraints: {}, context,
    })).toEqual({ ok: true })
    expect(authorizeToolInvocation({
      tool: rateChangeTool, permission: 'propose', args: {}, constraints: {}, context,
    })).toMatchObject({ ok: false, code: 'TOOL_PLANE_DENIED' })
  })

  it('requires rates.propose for an admin exchange-rate change', () => {
    const rateChangeTool: ToolDefinition = {
      key: 'exchange_rates.propose_pair_change', version: 1, description: 'test',
      argumentSchema: {}, returnSchema: '{}', grantPermissions: ['propose'],
      category: 'rates', risk: 'high',
    }
    const base = {
      plane: 'admin' as const, channel: 'whatsapp' as const, simulation: false,
      agentPurpose: 'admin_operations' as const, trustedAdminIdentityId: 'admin-1', features,
    }
    expect(authorizeToolInvocation({
      tool: rateChangeTool, permission: 'propose', args: {}, constraints: {},
      context: { ...base, trustedAdminCapabilities: [] },
    })).toMatchObject({ ok: false, code: 'ADMIN_CAPABILITY_DENIED' })
    expect(authorizeToolInvocation({
      tool: rateChangeTool, permission: 'propose', args: {}, constraints: {},
      context: { ...base, trustedAdminCapabilities: ['rates.propose'] },
    })).toEqual({ ok: true })
  })

  it('keeps service pricing mutations off the customer plane', () => {
    const pricingTool: ToolDefinition = {
      key: 'pricing_rules.propose_service_price', version: 1, description: 'test',
      argumentSchema: {}, returnSchema: '{}', grantPermissions: ['propose'],
      category: 'pricing', risk: 'high',
    }
    const result = authorizeToolInvocation({
      tool: pricingTool,
      permission: 'propose',
      args: {},
      constraints: {},
      context: {
        plane: 'customer', channel: 'whatsapp', simulation: false,
        agentPurpose: 'customer_support', trustedAdminIdentityId: null,
        trustedAdminCapabilities: [], features,
      },
    })
    expect(result).toMatchObject({ ok: false, code: 'TOOL_PLANE_DENIED' })
  })

})
