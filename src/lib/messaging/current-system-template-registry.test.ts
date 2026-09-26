import { describe, expect, it } from 'vitest'
import {
  CURRENT_SYSTEM_TEMPLATE_REGISTRY,
  findSystemMessageTemplate,
} from './current-system-template-registry'

describe('current system template composition', () => {
  it('resolves Coverage and FX templates from their owning domains', () => {
    expect(
      CURRENT_SYSTEM_TEMPLATE_REGISTRY.ownerOf({
        key: 'coverage.offer.approved',
        audience: 'customer',
        channel: 'whatsapp',
        locale: 'ar',
      }),
    ).toBe('coverage')
    expect(
      CURRENT_SYSTEM_TEMPLATE_REGISTRY.ownerOf({
        key: 'exchange_rate.trade.approved',
        audience: 'customer',
        channel: 'whatsapp',
        locale: 'ar',
      }),
    ).toBe('exchange_rates')
  })

  it('keeps generic service/change-request templates in Messaging Platform', () => {
    expect(
      CURRENT_SYSTEM_TEMPLATE_REGISTRY.ownerOf({
        key: 'service_request.approved',
        audience: 'customer',
        channel: 'whatsapp',
        locale: 'ar',
      }),
    ).toBe('messaging')
    expect(
      CURRENT_SYSTEM_TEMPLATE_REGISTRY.ownerOf({
        key: 'change_request.pending',
        audience: 'admin',
        channel: 'whatsapp',
        locale: 'ar',
      }),
    ).toBe('messaging')
  })

  it('quarantines legacy business copy outside generic Messaging defaults', () => {
    expect(
      CURRENT_SYSTEM_TEMPLATE_REGISTRY.ownerOf({
        key: 'remittance.completed',
        audience: 'customer',
        channel: 'whatsapp',
        locale: 'ar',
      }),
    ).toBe('legacy-remittance')
  })

  it('preserves the public system lookup used by resolver and emergency fallback', () => {
    expect(
      findSystemMessageTemplate({
        key: 'coverage.request.approved',
        audience: 'customer',
        channel: 'whatsapp',
        locale: 'ar',
      })?.key,
    ).toBe('coverage.request.approved')
  })
})
