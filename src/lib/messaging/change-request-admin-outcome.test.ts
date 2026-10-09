import { describe, expect, it } from 'vitest'
import { renderChangeRequestAdminOutcomeMessage } from './change-request-admin-outcome'
import type { TemplateOverrideStore } from './types'

function store(body: string, secretVariables: string[] = []): TemplateOverrideStore {
  return {
    async getPublishedTemplate(input) {
      if (input.key !== 'change_request.approved') return null
      return {
        revisionId: 'rev-1',
        version: 2,
        key: input.key,
        audience: input.audience,
        channel: input.channel,
        locale: input.locale,
        body,
        secretVariables,
      }
    },
  }
}

describe('renderChangeRequestAdminOutcomeMessage', () => {
  it('renders the reviewed system approval outcome', async () => {
    const result = await renderChangeRequestAdminOutcomeMessage({
      accountId: 'account-1',
      changeRequestId: 'request-1',
      requestCode: 12,
      outcome: 'approved',
      targetType: 'coverage_offer',
      proposedPayload: { amount: 150000, currency: 'SAR' },
      customerDeliveryLabel: 'تم إشعاره بالنتيجة ✅',
    })

    expect(result.source).toBe('system')
    expect(result.text).toContain('CHG-12')
    expect(result.text).toContain('150,000 SAR')
    expect(result.text).toContain('تم إشعاره بالنتيجة')
  })

  it('uses a valid account override', async () => {
    const result = await renderChangeRequestAdminOutcomeMessage({
      accountId: 'account-1',
      changeRequestId: 'request-1',
      requestCode: 12,
      outcome: 'approved',
      targetType: 'coverage_offer',
      store: store('✅ مخصص {{entity.reference}}'),
    })

    expect(result.source).toBe('account')
    expect(result.version).toBe(2)
    expect(result.text).toBe('✅ مخصص CHG-12')
  })

  it('falls back to system when an override tries to use secrets', async () => {
    const result = await renderChangeRequestAdminOutcomeMessage({
      accountId: 'account-1',
      changeRequestId: 'request-1',
      requestCode: 12,
      outcome: 'approved',
      targetType: 'coverage_offer',
      store: store('تم {{entity.reference}} {{secret.confirmation_code}}', ['confirmation_code']),
    })

    expect(result.source).toBe('system')
    expect(result.fallbackReason).toBe('ADMIN_OUTCOME_TEMPLATE_SECRETS_FORBIDDEN')
    expect(result.text).toContain('CHG-12')
  })

  it('renders rejection details without changing the decision', async () => {
    const result = await renderChangeRequestAdminOutcomeMessage({
      accountId: 'account-1',
      changeRequestId: 'request-1',
      requestCode: 13,
      outcome: 'rejected',
      targetType: 'remittance',
      reason: 'بيانات المستفيد غير مكتملة',
      customerDeliveryLabel: 'تم إشعاره بالرفض ✅',
    })

    expect(result.source).toBe('system')
    expect(result.text).toContain('CHG-13')
    expect(result.text).toContain('بيانات المستفيد غير مكتملة')
    expect(result.text).toContain('تم إشعاره بالرفض')
  })
})
