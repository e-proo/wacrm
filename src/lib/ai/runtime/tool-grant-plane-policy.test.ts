import { describe, expect, it } from 'vitest'
import {
  inheritedGrantAllowedForPurpose,
  planeForAgentPurpose,
} from './tool-grant-plane-policy'

const grant = (tool_key: string, tool_version: number, permission: string) => ({
  tool_key,
  tool_version,
  permission,
})

describe('tool grant plane inheritance policy', () => {
  it('maps fixed agent purposes to their runtime planes', () => {
    expect(planeForAgentPurpose('customer_support')).toBe('customer')
    expect(planeForAgentPurpose('admin_operations')).toBe('admin')
    expect(planeForAgentPurpose('custom')).toBeNull()
  })

  it('keeps tools shared by customer and admin planes', () => {
    expect(
      inheritedGrantAllowedForPurpose(
        grant('services.search', 1, 'read'),
        'customer_support',
      ).allowed,
    ).toBe(true)
    expect(
      inheritedGrantAllowedForPurpose(
        grant('services.search', 1, 'read'),
        'admin_operations',
      ).allowed,
    ).toBe(true)
  })

  it('drops admin-only tools from customer drafts', () => {
    for (const tool of [
      grant('change_requests.list_pending', 1, 'read'),
      grant('coverage.admin_list_offers', 1, 'read'),
      grant('coverage.admin_list_requests', 1, 'read'),
      grant('exchange_rates.admin_list_books', 1, 'read'),
      grant('exchange_rates.propose_pair_change', 1, 'propose'),
      grant('intents.propose_decision', 1, 'propose'),
      grant('intents.search', 1, 'read'),
      grant('pricing_rules.propose_service_price', 1, 'propose'),
      grant('services.propose_update', 1, 'propose'),
    ]) {
      expect(inheritedGrantAllowedForPurpose(tool, 'customer_support')).toMatchObject({
        allowed: false,
        plane: 'customer',
        reason: 'plane_mismatch',
      })
    }
  })

  it('drops customer-only tools from admin drafts', () => {
    for (const tool of [
      grant('coverage.propose_offer', 2, 'propose'),
      grant('coverage.propose_request', 1, 'propose'),
      grant('exchange_rates.record_trade_request', 1, 'propose'),
    ]) {
      expect(inheritedGrantAllowedForPurpose(tool, 'admin_operations')).toMatchObject({
        allowed: false,
        plane: 'admin',
        reason: 'plane_mismatch',
      })
    }
  })

  it('fails closed for inherited grants without a current matching platform policy', () => {
    expect(
      inheritedGrantAllowedForPurpose(
        grant('legacy.unknown_tool', 1, 'read'),
        'customer_support',
      ),
    ).toMatchObject({ allowed: false, reason: 'tool_policy_missing' })
  })
})
