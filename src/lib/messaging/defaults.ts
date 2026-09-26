import type { MessageTemplateDefinition } from './types'

export const GENERAL_SYSTEM_MESSAGE_TEMPLATES: readonly MessageTemplateDefinition[] = [
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

/**
 * @deprecated Compatibility alias for messaging-owned generic defaults only.
 * Domain-owned templates are resolved through SystemTemplateRegistry.
 */
export const SYSTEM_MESSAGE_TEMPLATES = GENERAL_SYSTEM_MESSAGE_TEMPLATES
