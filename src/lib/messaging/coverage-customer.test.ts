import { describe, expect, it } from 'vitest'
import { renderCoverageApprovedCustomerMessage } from './coverage-customer'
import type { TemplateOverrideStore } from './types'

const base = {
  accountId: '11111111-1111-4111-8111-111111111111',
  entityId: '22222222-2222-4222-8222-222222222222',
  reference: 'COV-123',
  serviceId: '33333333-3333-4333-8333-333333333333',
  amount: '100000',
  currency: 'SAR',
  payRegion: 'حضرموت',
  payMethod: 'cash',
  receiveRegion: 'صنعاء',
  receiveMethod: 'networks',
  commissionAmount: '700',
  commissionCurrency: 'SAR',
} as const

describe('renderCoverageApprovedCustomerMessage', () => {
  it('renders SOUTH -> NORTH offer semantics with customer-returned commission', async () => {
    const rendered = await renderCoverageApprovedCustomerMessage({ ...base, kind: 'offer' })

    expect(rendered.source).toBe('system')
    expect(rendered.eventKey).toBe('coverage.offer.approved')
    expect(rendered.text).toContain('عرض التغطية')
    expect(rendered.text).toContain('رقم العرض: COV-123')
    expect(rendered.text).toContain('100,000 SAR')
    expect(rendered.text).toContain('الدفع: حضرموت — نقدًا')
    expect(rendered.text).toContain('الاستلام: صنعاء — شبكات')
    expect(rendered.text).toContain('الراجع لك: 700 SAR')
    expect(rendered.text).not.toContain('العمولة عليك')
  })

  it('renders NORTH -> SOUTH request semantics with customer-paid commission', async () => {
    const rendered = await renderCoverageApprovedCustomerMessage({
      ...base,
      kind: 'request',
      payRegion: 'صنعاء',
      receiveRegion: 'عدن',
    })

    expect(rendered.eventKey).toBe('coverage.request.approved')
    expect(rendered.text).toContain('طلب التغطية')
    expect(rendered.text).toContain('رقم الطلب: COV-123')
    expect(rendered.text).toContain('العمولة عليك: 700 SAR')
    expect(rendered.text).not.toContain('الراجع لك')
  })

  it('uses a distinct commission currency when provided', async () => {
    const rendered = await renderCoverageApprovedCustomerMessage({
      ...base,
      kind: 'offer',
      commissionCurrency: 'USD',
    })

    expect(rendered.text).toContain('الراجع لك: 700 USD')
  })

  it('accepts a safe account override', async () => {
    const store: TemplateOverrideStore = {
      async getPublishedTemplate(input) {
        if (input.key !== 'coverage.offer.approved') return null
        return {
          revisionId: 'rev-1',
          version: 2,
          key: input.key,
          audience: 'customer',
          channel: 'whatsapp',
          locale: 'ar',
          body: 'اعتمد العرض بمبلغ {{money.amount}} {{money.currency}} — {{data.pay_region}} إلى {{data.receive_region}}',
          requiredVariables: ['money.amount', 'money.currency'],
        }
      },
    }

    const rendered = await renderCoverageApprovedCustomerMessage({ ...base, kind: 'offer', store })
    expect(rendered.source).toBe('account')
    expect(rendered.revisionId).toBe('rev-1')
    expect(rendered.text).toContain('100,000 SAR')
  })

  it('falls back to system when an override attempts to use secrets', async () => {
    const store: TemplateOverrideStore = {
      async getPublishedTemplate(input) {
        if (input.key !== 'coverage.offer.approved') return null
        return {
          revisionId: 'bad-rev',
          version: 3,
          key: input.key,
          audience: 'customer',
          channel: 'whatsapp',
          locale: 'ar',
          body: '{{money.amount}} {{money.currency}} {{secret.pin}}',
          requiredVariables: ['money.amount', 'money.currency'],
          secretVariables: ['pin'],
        }
      },
    }

    const rendered = await renderCoverageApprovedCustomerMessage({ ...base, kind: 'offer', store })
    expect(rendered.source).toBe('system')
    expect(rendered.fallbackReason).toBe('COVERAGE_TEMPLATE_SECRETS_FORBIDDEN')
    expect(rendered.text).toContain('تم اعتماد عرض التغطية')
  })

  it('uses an authoritative commission amount when the domain snapshot supplies one', async () => {
    const rendered = await renderCoverageApprovedCustomerMessage({
      ...base,
      kind: 'offer',
      commissionAmount: '701.2345',
    })

    expect(rendered.text).toContain('الراجع لك: 701.2345 SAR')
    expect(rendered.text).not.toContain('الراجع لك: 700 SAR')
  })

  it('omits commission instead of calculating business facts inside messaging', async () => {
    const rendered = await renderCoverageApprovedCustomerMessage({
      ...base,
      kind: 'offer',
      commissionAmount: null,
    })

    expect(rendered.text).not.toContain('الراجع لك:')
    expect(rendered.text).not.toContain('العمولة عليك:')
  })
})
