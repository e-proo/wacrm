import type { MessageTemplateDefinition } from '@/lib/messaging/types'

export const COVERAGE_MESSAGE_TEMPLATES: readonly MessageTemplateDefinition[] = [
  {
    key: 'coverage.offer.approved',
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    body: [
      '✅ *تم اعتماد عرض التغطية الخاص بك*',
      '{{#if entity.reference}}رقم العرض: {{entity.reference}}{{/if}}',
      'المبلغ: {{money.amount}} {{money.currency}}',
      'الدفع: {{data.pay_region}} — {{data.pay_method}}',
      'الاستلام: {{data.receive_region}} — {{data.receive_method}}',
      '{{#if money.commission}}{{data.commission_label}}: {{money.commission}} {{money.commission_currency}}{{/if}}',
      '',
      'أصبح العرض مسجلاً وجاهزًا للمعالجة.',
    ].join('\n'),
    requiredVariables: [
      'money.amount',
      'money.currency',
      'data.pay_region',
      'data.pay_method',
      'data.receive_region',
      'data.receive_method',
    ],
    optionalVariables: [
      'entity.reference',
      'money.commission',
      'money.commission_currency',
      'data.commission_label',
    ],
  },
  {
    key: 'coverage.request.approved',
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    body: [
      '✅ *تم اعتماد طلب التغطية الخاص بك*',
      '{{#if entity.reference}}رقم الطلب: {{entity.reference}}{{/if}}',
      'المبلغ: {{money.amount}} {{money.currency}}',
      'الدفع: {{data.pay_region}} — {{data.pay_method}}',
      'الاستلام: {{data.receive_region}} — {{data.receive_method}}',
      '{{#if money.commission}}{{data.commission_label}}: {{money.commission}} {{money.commission_currency}}{{/if}}',
      '',
      'تم إدراج الطلب للمعالجة.',
    ].join('\n'),
    requiredVariables: [
      'money.amount',
      'money.currency',
      'data.pay_region',
      'data.pay_method',
      'data.receive_region',
      'data.receive_method',
    ],
    optionalVariables: [
      'entity.reference',
      'money.commission',
      'money.commission_currency',
      'data.commission_label',
    ],
  },
]
