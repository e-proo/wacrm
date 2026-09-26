import type { MessageTemplateDefinition } from '@/lib/messaging/types'

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

export const FX_V2_MESSAGE_TEMPLATES: readonly MessageTemplateDefinition[] = [
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
    requiredVariables: [
      'data.base_currency',
      'data.quote_currency',
      'data.buy_rate',
      'data.sell_rate',
    ],
    optionalVariables: ['data.market_label', 'data.rate_unit_label'],
  },
  {
    key: 'exchange_rate.trade.requested',
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    body: [
      '🕓 تم استلام طلب الصرف وهو بانتظار مراجعة الإدارة.',
      ...FX_TRADE_DETAIL_LINES,
    ].join('\n'),
    requiredVariables: FX_TRADE_REQUIRED_VARIABLES,
  },
  {
    key: 'exchange_rate.trade.approved',
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    body: [
      '✅ تم قبول طلب الصرف.',
      'ستتواصل معك الإدارة في أقرب وقت لمتابعة التنفيذ.',
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
    body: [
      '⛔ تمت مراجعة طلب الصرف ولم يتم اعتماده.',
      ...FX_TRADE_DETAIL_LINES,
    ].join('\n'),
    requiredVariables: FX_TRADE_REQUIRED_VARIABLES,
  },
  {
    key: 'exchange_rate.trade.completed',
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    body: [
      '✅ تم إتمام عملية الصرف وتسجيلها كمكتملة.',
      ...FX_TRADE_DETAIL_LINES,
    ].join('\n'),
    requiredVariables: FX_TRADE_REQUIRED_VARIABLES,
  },
]
