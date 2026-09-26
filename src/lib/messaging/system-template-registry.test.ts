import { describe, expect, it } from 'vitest'
import { SystemTemplateRegistry } from './system-template-registry'
import type { MessageTemplateDefinition } from './types'

function template(
  overrides: Partial<MessageTemplateDefinition> = {},
): MessageTemplateDefinition {
  return {
    key: 'demo.approved',
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    body: 'تم',
    ...overrides,
  }
}

describe('SystemTemplateRegistry', () => {
  it('registers templates with explicit ownership', () => {
    const registry = new SystemTemplateRegistry().register('demo', [
      template(),
    ])

    expect(
      registry.find({
        key: 'demo.approved',
        audience: 'customer',
        channel: 'whatsapp',
        locale: 'ar',
      })?.body,
    ).toBe('تم')
    expect(
      registry.ownerOf({
        key: 'demo.approved',
        audience: 'customer',
        channel: 'whatsapp',
        locale: 'ar',
      }),
    ).toBe('demo')
  })

  it('fails closed on duplicate system-template identities', () => {
    const registry = new SystemTemplateRegistry().register('one', [
      template(),
    ])
    expect(() => registry.register('two', [template()])).toThrow(
      'SYSTEM_TEMPLATE_DUPLICATE',
    )
  })

  it('rejects undeclared secret placeholders at registration time', () => {
    expect(() =>
      new SystemTemplateRegistry().register('unsafe', [
        template({ body: '{{secret.pin}}' }),
      ]),
    ).toThrow('SYSTEM_TEMPLATE_SECRET_NOT_DECLARED')
  })

  it('allows explicitly declared transient secrets', () => {
    expect(() =>
      new SystemTemplateRegistry().register('safe', [
        template({
          body: '{{secret.pin}}',
          secretVariables: ['pin'],
        }),
      ]),
    ).not.toThrow()
  })
})


describe('SystemTemplateRegistry secret conditionals', () => {
  it('rejects undeclared secret conditionals before runtime rendering', () => {
    expect(() =>
      new SystemTemplateRegistry().register('unsafe-conditional', [
        template({ body: '{{#if secret.pin}}hidden{{/if}}' }),
      ]),
    ).toThrow('SYSTEM_TEMPLATE_SECRET_NOT_DECLARED')
  })
})
