import type { MessageTemplateDefinition } from './types'

/**
 * Legacy system copy with no registered BusinessDomain owner yet.
 *
 * Keep isolated from generic Messaging defaults so Phase 4 does not recreate
 * a central business-template bucket. A future Remittance domain can claim
 * this key without changing the resolver contract.
 */
export const LEGACY_SYSTEM_MESSAGE_TEMPLATES: readonly MessageTemplateDefinition[] = [
  {
    key: 'remittance.completed',
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    body: [
      '✅ *تم تنفيذ الحوالة بنجاح*',
      '{{#if entity.reference}}المرجع: {{entity.reference}}{{/if}}',
      'المبلغ: {{money.amount}} {{money.currency}}',
      '{{#if data.beneficiary_name}}المستفيد: {{data.beneficiary_name}}{{/if}}',
      '{{#if data.destination}}الوجهة: {{data.destination}}{{/if}}',
      '{{#if data.delivery_method}}طريقة الاستلام: {{data.delivery_method}}{{/if}}',
    ].join('\n'),
    requiredVariables: ['money.amount', 'money.currency'],
    optionalVariables: [
      'entity.reference',
      'data.beneficiary_name',
      'data.destination',
      'data.delivery_method',
    ],
  },
]
