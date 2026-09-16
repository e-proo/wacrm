import { describe, expect, it } from 'vitest'
import { renderPendingChangeRequestAdminMessage } from './change-request-admin'
import type { PublishedTemplateOverride, TemplateOverrideStore } from './types'

function overrideStore(
  override: PublishedTemplateOverride | null,
): TemplateOverrideStore {
  return {
    async getPublishedTemplate() {
      return override
    },
  }
}

const baseInput = {
  accountId: '00000000-0000-0000-0000-000000000001',
  changeRequestId: '00000000-0000-0000-0000-000000000002',
  requestCode: 22,
  confirmationCode: '6534',
  summary: 'اعتماد عرض تغطية 150000 SAR',
  targetType: 'coverage_offer',
  proposedPayload: {
    total_amount: '150000',
    currency: 'SAR',
  },
}

describe('renderPendingChangeRequestAdminMessage', () => {
  it('renders the reviewed system approval template with transient PIN', async () => {
    const rendered = await renderPendingChangeRequestAdminMessage(baseInput)

    expect(rendered.source).toBe('system')
    expect(rendered.text).toContain('CHG-22')
    expect(rendered.text).toContain('6534')
    expect(rendered.text).toContain('عرض تغطية')
    expect(rendered.text).toContain('150,000 SAR')
    expect(rendered.text).toContain('اعتماد CHG-22 6534')
  })

  it('uses a valid published account override', async () => {
    const override: PublishedTemplateOverride = {
      revisionId: 'rev-1',
      version: 3,
      key: 'change_request.pending',
      audience: 'admin',
      channel: 'whatsapp',
      locale: 'ar',
      body: 'موافقة مطلوبة: {{entity.reference}}\nنفذ: اعتماد {{entity.reference}} {{secret.confirmation_code}}',
      requiredVariables: ['entity.reference'],
      secretVariables: ['confirmation_code'],
    }

    const rendered = await renderPendingChangeRequestAdminMessage({
      ...baseInput,
      store: overrideStore(override),
    })

    expect(rendered.source).toBe('account')
    expect(rendered.revisionId).toBe('rev-1')
    expect(rendered.version).toBe(3)
    expect(rendered.text).toBe('موافقة مطلوبة: CHG-22\nنفذ: اعتماد CHG-22 6534')
  })

  it('falls back to the system template when an override omits the PIN placeholder', async () => {
    const unsafeOverride: PublishedTemplateOverride = {
      revisionId: 'rev-unsafe',
      version: 4,
      key: 'change_request.pending',
      audience: 'admin',
      channel: 'whatsapp',
      locale: 'ar',
      body: 'راجع {{entity.reference}}',
      requiredVariables: ['entity.reference'],
      secretVariables: ['confirmation_code'],
    }

    const rendered = await renderPendingChangeRequestAdminMessage({
      ...baseInput,
      store: overrideStore(unsafeOverride),
    })

    expect(rendered.source).toBe('system')
    expect(rendered.fallbackReason).toBe('APPROVAL_TEMPLATE_SECRET_PLACEHOLDER_REQUIRED')
    expect(rendered.text).toContain('اعتماد CHG-22 6534')
  })

  it('falls back safely when the override store is unavailable', async () => {
    const store: TemplateOverrideStore = {
      async getPublishedTemplate() {
        throw new Error('database unavailable')
      },
    }

    const rendered = await renderPendingChangeRequestAdminMessage({
      ...baseInput,
      store,
    })

    expect(rendered.source).toBe('system')
    expect(rendered.fallbackReason).toBe('MESSAGE_TEMPLATE_OVERRIDE_UNAVAILABLE')
    expect(rendered.text).toContain('اعتماد CHG-22 6534')
  })
})
