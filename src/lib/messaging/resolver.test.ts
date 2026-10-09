import { describe, expect, it } from 'vitest'
import { resolveMessageTemplate } from './resolver'
import type { TemplateOverrideStore } from './types'

function storeWithBody(body: string): TemplateOverrideStore {
  return {
    async getPublishedTemplate(input) {
      if (input.key !== 'coverage.offer.approved' || input.locale !== 'ar') return null
      return {
        revisionId: 'revision-1',
        version: 3,
        key: input.key,
        audience: input.audience,
        channel: input.channel,
        locale: input.locale,
        body,
      }
    },
  }
}

describe('resolveMessageTemplate', () => {
  it('prefers an account override over the system default', async () => {
    const resolved = await resolveMessageTemplate({
      accountId: 'account-1',
      eventKey: 'coverage.offer.approved',
      audience: 'customer',
      channel: 'whatsapp',
      locale: 'ar-YE',
      store: storeWithBody('قالب مخصص'),
    })

    expect(resolved.source).toBe('account')
    expect(resolved.template.body).toBe('قالب مخصص')
    expect(resolved.version).toBe(3)
  })

  it('falls back from a new domain event to generic service lifecycle copy', async () => {
    const resolved = await resolveMessageTemplate({
      accountId: 'account-1',
      eventKey: 'future_service.approved',
      audience: 'customer',
      channel: 'whatsapp',
      locale: 'ar-YE',
    })

    expect(resolved.source).toBe('system')
    expect(resolved.resolvedEventKey).toBe('service_request.approved')
    expect(resolved.resolvedLocale).toBe('ar')
  })

  it('fails closed when neither a domain nor generic template exists', async () => {
    await expect(
      resolveMessageTemplate({
        accountId: 'account-1',
        eventKey: 'future_service.quoted',
        audience: 'customer',
        channel: 'whatsapp',
        locale: 'ar',
      }),
    ).rejects.toThrow('MESSAGE_TEMPLATE_NOT_FOUND')
  })
})
