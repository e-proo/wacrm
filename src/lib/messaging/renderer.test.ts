import { describe, expect, it } from 'vitest'
import { renderMessageTemplate } from './renderer'
import type { MessageContext, MessageTemplateDefinition } from './types'

const context: MessageContext = {
  entity: { type: 'coverage_offer', reference: 'CHG-9' },
  money: { amount: '150,000', currency: 'SAR' },
  data: { summary: 'اختبار' },
}

function template(overrides: Partial<MessageTemplateDefinition> = {}): MessageTemplateDefinition {
  return {
    key: 'test.approved',
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    body: 'المرجع: {{entity.reference}}',
    ...overrides,
  }
}

describe('renderMessageTemplate', () => {
  it('renders scalar dotted variables', () => {
    expect(renderMessageTemplate({ template: template(), context })).toBe('المرجع: CHG-9')
  })

  it('removes absent conditional blocks and keeps present ones', () => {
    const rendered = renderMessageTemplate({
      template: template({
        body: '{{#if data.summary}}الملخص: {{data.summary}}{{/if}}\n{{#if data.reason}}السبب: {{data.reason}}{{/if}}',
      }),
      context,
    })
    expect(rendered).toBe('الملخص: اختبار')
  })

  it('fails closed when a required variable is missing', () => {
    expect(() =>
      renderMessageTemplate({
        template: template({ requiredVariables: ['customer.name'] }),
        context,
      }),
    ).toThrow('Required variable customer.name is missing')
  })

  it('allows only explicitly declared transient secrets', () => {
    const secure = template({
      audience: 'admin',
      body: 'اعتماد {{entity.reference}} {{secret.confirmation_code}}',
      secretVariables: ['confirmation_code'],
    })
    expect(
      renderMessageTemplate({
        template: secure,
        context,
        secrets: { confirmation_code: '4321' },
      }),
    ).toBe('اعتماد CHG-9 4321')
  })

  it('rejects undeclared secret placeholders', () => {
    expect(() =>
      renderMessageTemplate({
        template: template({ body: '{{secret.confirmation_code}}' }),
        context,
        secrets: { confirmation_code: '4321' },
      }),
    ).toThrow('Secret variable confirmation_code is referenced but not declared')
  })

  it('rejects oversized channel output', () => {
    expect(() =>
      renderMessageTemplate({
        template: template({ body: '123456', maxLength: 5 }),
        context,
      }),
    ).toThrow('exceeds 5 characters')
  })
})
