import type { MessageTemplateDefinition } from './types'

const FX_TRADE_REQUIRED_VARIABLES = [
  'entity.reference',
  'data.pair',
  'data.side_label',
  'money.amount',
  'money.currency',
  'data.effective_rate',
  'data.base_amount',
  'data.base_currency',
  'data.quote_amount',
  'data.quote_currency',
] as const

const FX_TRADE_DETAIL_LINES = [
  'المرجع: {{entity.reference}}',
  'الزوج: {{data.pair}}',
  'العملية: {{data.side_label}}',
  'المبلغ المطلوب: {{money.amount}} {{money.currency}}',
  'السعر الفعلي: {{data.effective_rate}} {{data.quote_currency}} لكل {{data.base_currency}}',
  'المبلغ الأساسي: {{data.base_amount}} {{data.base_currency}}',
  'المبلغ المقابل: {{data.quote_amount}} {{data.quote_currency}}',
] as const

export const SYSTEM_MESSAGE_TEMPLATES: readonly MessageTemplateDefinition[] = [
  {
    key: 'change_request.pending',
    audience: 'admin',
    channel: 'whatsapp',
    locale: 'ar',
    body: [
      '🔔 *طلب اعتماد جديد*',
      'المرجع: {{entity.reference}}',
      '{{#if service.name}}الخدمة: {{service.name}}{{/if}}',
      '{{#if data.type_label}}النوع: {{data.type_label}}{{/if}}',
      '{{#if data.summary}}الملخص: {{data.summary}}{{/if}}',
      '{{#if money.amount}}المبلغ: {{money.amount}} {{money.currency}}{{/if}}',
      '',
      'للاعتماد: اعتماد {{entity.reference}} {{secret.confirmation_code}}',
      'للرفض: رفض {{entity.reference}}',
    ].join('\n'),
    requiredVariables: ['entity.reference'],
    optionalVariables: ['service.name', 'data.type_label', 'data.summary', 'money.amount', 'money.currency'],
    secretVariables: ['confirmation_code'],
  },
  {
    key: 'change_request.approved',
    audience: 'admin',
    channel: 'whatsapp',
    locale: 'ar',
    body: [
      '✅ *تم اعتماد الطلب وتنفيذه بنجاح*',
      'المرجع: {{entity.reference}}',
      '{{#if service.name}}الخدمة: {{service.name}}{{/if}}',
      '{{#if money.amount}}المبلغ: {{money.amount}} {{money.currency}}{{/if}}',
      '{{#if data.customer_delivery_label}}العميل: {{data.customer_delivery_label}}{{/if}}',
    ].join('\n'),
    requiredVariables: ['entity.reference'],
    optionalVariables: ['service.name', 'money.amount', 'money.currency', 'data.customer_delivery_label'],
  },
  {
    key: 'change_request.rejected',
    audience: 'admin',
    channel: 'whatsapp',
    locale: 'ar',
    body: [
      '⛔ *تم رفض الطلب*',
      'المرجع: {{entity.reference}}',
      '{{#if service.name}}الخدمة: {{service.name}}{{/if}}',
      '{{#if data.reason}}السبب: {{data.reason}}{{/if}}',
      '{{#if data.customer_delivery_label}}العميل: {{data.customer_delivery_label}}{{/if}}',
    ].join('\n'),
    requiredVariables: ['entity.reference'],
    optionalVariables: ['service.name', 'data.reason', 'data.customer_delivery_label'],
  },
  {
    key: 'service_request.pending',
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    body: [
      '🕓 تم استلام طلبك وهو الآن بانتظار المراجعة.',
      '{{#if entity.reference}}المرجع: {{entity.reference}}{{/if}}',
      '{{#if service.name}}الخدمة: {{service.name}}{{/if}}',
    ].join('\n'),
    optionalVariables: ['entity.reference', 'service.name'],
  },
  {
    key: 'service_request.approved',
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    body: [
      '✅ تم اعتماد طلبك بنجاح.',
      '{{#if entity.reference}}المرجع: {{entity.reference}}{{/if}}',
      '{{#if service.name}}الخدمة: {{service.name}}{{/if}}',
      '{{#if data.summary}}التفاصيل: {{data.summary}}{{/if}}',
    ].join('\n'),
    optionalVariables: ['entity.reference', 'service.name', 'data.summary'],
  },
  {
    key: 'service_request.rejected',
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    body: [
      'تمت مراجعة طلبك ولم يتم اعتماده.',
      '{{#if entity.reference}}المرجع: {{entity.reference}}{{/if}}',
      '{{#if data.customer_reason}}التوضيح: {{data.customer_reason}}{{/if}}',
    ].join('\n'),
    optionalVariables: ['entity.reference', 'data.customer_reason'],
  },
  {
    key: 'service_request.matched',
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    body: [
      '✅ تمت مراجعة طلبك وربطه بخدمة متوفرة لدينا.',
      '{{#if entity.reference}}المرجع: {{entity.reference}}{{/if}}',
      '{{#if service.name}}الخدمة: {{service.name}}{{/if}}',
      '{{#if data.summary}}التفاصيل: {{data.summary}}{{/if}}',
    ].join('\n'),
    optionalVariables: ['entity.reference', 'service.name', 'data.summary'],
  },
  {
    key: 'service_request.needs_clarification',
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    body: [
      'نحتاج إلى معلومات إضافية قبل إكمال مراجعة طلبك.',
      '{{#if entity.reference}}المرجع: {{entity.reference}}{{/if}}',
      '{{#if service.name}}الخدمة: {{service.name}}{{/if}}',
      '{{#if data.summary}}التفاصيل: {{data.summary}}{{/if}}',
    ].join('\n'),
    optionalVariables: ['entity.reference', 'service.name', 'data.summary'],
  },
  {
    key: 'service_request.completed',
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    body: [
      '✅ تم إكمال طلبك بنجاح.',
      '{{#if entity.reference}}المرجع: {{entity.reference}}{{/if}}',
      '{{#if service.name}}الخدمة: {{service.name}}{{/if}}',
      '{{#if data.summary}}التفاصيل: {{data.summary}}{{/if}}',
    ].join('\n'),
    optionalVariables: ['entity.reference', 'service.name', 'data.summary'],
  },
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
    optionalVariables: ['entity.reference', 'money.commission', 'money.commission_currency', 'data.commission_label'],
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
    optionalVariables: ['entity.reference', 'money.commission', 'money.commission_currency', 'data.commission_label'],
  },
  {
    key: 'exchange_rate.quote.completed',
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    body: [
      '💱 *سعر الصرف*',
      '{{data.base_currency}} / {{data.quote_currency}}',
      'شراء: {{data.buy_rate}}',
      'بيع: {{data.sell_rate}}',
      '{{#if data.market_label}}السوق: {{data.market_label}}{{/if}}',
      '{{#if data.rate_unit_label}}الوحدة: {{data.rate_unit_label}}{{/if}}',
    ].join('\n'),
    requiredVariables: ['data.base_currency', 'data.quote_currency', 'data.buy_rate', 'data.sell_rate'],
    optionalVariables: ['data.market_label', 'data.rate_unit_label'],
  },
  {
    key: 'exchange_rate.trade.requested',
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    body: ['🕓 تم استلام طلب الصرف وهو بانتظار مراجعة الإدارة.', ...FX_TRADE_DETAIL_LINES].join('\n'),
    requiredVariables: FX_TRADE_REQUIRED_VARIABLES,
  },
  {
    key: 'exchange_rate.trade.approved',
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    body: [
      '✅ تم اعتماد طلب الصرف للتواصل معك ومتابعة التنفيذ.',
      'تنبيه: الطلب لم يُسجل كمكتمل بعد.',
      ...FX_TRADE_DETAIL_LINES,
    ].join('\n'),
    requiredVariables: FX_TRADE_REQUIRED_VARIABLES,
  },
  {
    key: 'exchange_rate.trade.rejected',
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    body: ['⛔ تمت مراجعة طلب الصرف ولم يتم اعتماده.', ...FX_TRADE_DETAIL_LINES].join('\n'),
    requiredVariables: FX_TRADE_REQUIRED_VARIABLES,
  },
  {
    key: 'exchange_rate.trade.completed',
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    body: ['✅ تم إتمام عملية الصرف وتسجيلها كمكتملة.', ...FX_TRADE_DETAIL_LINES].join('\n'),
    requiredVariables: FX_TRADE_REQUIRED_VARIABLES,
  },
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
    optionalVariables: ['entity.reference', 'data.beneficiary_name', 'data.destination', 'data.delivery_method'],
  },
]

export function findSystemMessageTemplate(input: {
  key: string
  audience: MessageTemplateDefinition['audience']
  channel: MessageTemplateDefinition['channel']
  locale: string
}): MessageTemplateDefinition | null {
  return (
    SYSTEM_MESSAGE_TEMPLATES.find(
      (template) =>
        template.key === input.key &&
        template.audience === input.audience &&
        template.channel === input.channel &&
        template.locale === input.locale,
    ) ?? null
  )
}
