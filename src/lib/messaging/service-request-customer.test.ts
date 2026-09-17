import { describe, expect, it } from 'vitest'
import { renderServiceRequestCustomerMessage } from './service-request-customer'
import type { TemplateOverrideStore } from './types'

const base = {
  accountId: '11111111-1111-4111-8111-111111111111',
  entityId: '22222222-2222-4222-8222-222222222222',
  reference: 'REQ-42',
} as const

describe('renderServiceRequestCustomerMessage', () => {
  it.each([
    ['approved', 'تم اعتماد طلبك بنجاح'],
    ['rejected', 'لم يتم اعتماده'],
    ['matched', 'ربطه بخدمة'],
    ['needs_clarification', 'معلومات إضافية'],
    ['completed', 'تم إكمال طلبك بنجاح'],
  ] as const)('renders the %s lifecycle event', async (outcome, expected) => {
    const rendered = await renderServiceRequestCustomerMessage({ ...base, outcome })
    expect(rendered.source).toBe('system')
    expect(rendered.eventKey).toBe(`service_request.${outcome}`)
    expect(rendered.text).toContain(expected)
  })

  it('renders matched service identity when supplied', async () => {
    const rendered = await renderServiceRequestCustomerMessage({
      ...base,
      outcome: 'matched',
      serviceName: 'حوالات محلية',
    })
    expect(rendered.text).toContain('الخدمة: حوالات محلية')
  })

  it('accepts a safe account override', async () => {
    const store: TemplateOverrideStore = {
      async getPublishedTemplate(input) {
        if (input.key !== 'service_request.approved') return null
        return {
          revisionId: 'revision-1',
          version: 4,
          key: input.key,
          audience: 'customer',
          channel: 'whatsapp',
          locale: 'ar',
          body: 'تم اعتماد طلب الخدمة {{entity.reference}}',
          optionalVariables: ['entity.reference'],
        }
      },
    }
    const rendered = await renderServiceRequestCustomerMessage({
      ...base,
      outcome: 'approved',
      store,
    })
    expect(rendered.source).toBe('account')
    expect(rendered.revisionId).toBe('revision-1')
    expect(rendered.text).toContain('REQ-42')
  })

  it('falls back to system when an override tries to use secrets', async () => {
    const store: TemplateOverrideStore = {
      async getPublishedTemplate(input) {
        if (input.key !== 'service_request.rejected') return null
        return {
          revisionId: 'unsafe',
          version: 2,
          key: input.key,
          audience: 'customer',
          channel: 'whatsapp',
          locale: 'ar',
          body: 'رفض {{secret.internal}}',
          secretVariables: ['internal'],
        }
      },
    }
    const rendered = await renderServiceRequestCustomerMessage({
      ...base,
      outcome: 'rejected',
      store,
    })
    expect(rendered.source).toBe('system')
    expect(rendered.fallbackReason).toBe('SERVICE_REQUEST_TEMPLATE_SECRETS_FORBIDDEN')
    expect(rendered.text).toContain('لم يتم اعتماده')
  })
})
