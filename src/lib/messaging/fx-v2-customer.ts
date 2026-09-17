import { buildFxTradeMessageContext, formatMessageNumber } from './domains'
import { findSystemMessageTemplate } from './defaults'
import { renderMessageTemplate } from './renderer'
import { resolveMessageTemplate } from './resolver'
import type { MessageTemplateDefinition, TemplateOverrideStore } from './types'

export type FxTradeCustomerOutcome =
  | 'pending_admin'
  | 'approved_for_contact'
  | 'rejected'
  | 'completed'

export interface FxTradeCustomerMessageInput {
  accountId: string
  outcome: FxTradeCustomerOutcome
  requestId: string
  reference: string
  side: 'customer_buy' | 'customer_sell'
  amountBasis: 'base' | 'quote'
  requestedAmount: string | number
  effectiveRate: string | number
  baseAmount: string | number
  quoteAmount: string | number
  baseCurrency: string
  quoteCurrency: string
  rateVersionId: string
  locale?: string | null
  store?: TemplateOverrideStore | null
}

export interface RenderedFxTradeCustomerMessage {
  text: string
  source: 'account' | 'system' | 'emergency'
  eventKey: string
  resolvedLocale: string
  revisionId?: string
  version?: number
  fallbackReason?: string
}

// Internal workflow statuses are deliberately separate from the durable
// business-event contract consumed by messaging and other integrations.
const EVENT_BY_OUTCOME: Record<FxTradeCustomerOutcome, string> = {
  pending_admin: 'exchange_rate.trade.requested',
  approved_for_contact: 'exchange_rate.trade.approved',
  rejected: 'exchange_rate.trade.rejected',
  completed: 'exchange_rate.trade.completed',
}

const REQUIRED_FINANCIAL_PLACEHOLDERS = [
  '{{entity.reference}}',
  '{{data.pair}}',
  '{{data.side_label}}',
  '{{money.amount}}',
  '{{money.currency}}',
  '{{data.effective_rate}}',
  '{{data.base_amount}}',
  '{{data.base_currency}}',
  '{{data.quote_amount}}',
  '{{data.quote_currency}}',
] as const

/**
 * Render an FX V2 trade lifecycle message from the immutable request snapshot.
 * No current-rate lookup or AI prose generation occurs here. Account overrides
 * must retain every financial placeholder or the system template is used.
 */
export async function renderFxTradeCustomerMessage(
  input: FxTradeCustomerMessageInput,
): Promise<RenderedFxTradeCustomerMessage> {
  const eventKey = EVENT_BY_OUTCOME[input.outcome]
  const context = buildFxTradeMessageContext({
    entityId: input.requestId,
    reference: input.reference,
    status: input.outcome,
    side: input.side,
    amountBasis: input.amountBasis,
    requestedAmount: input.requestedAmount,
    effectiveRate: input.effectiveRate,
    baseAmount: input.baseAmount,
    quoteAmount: input.quoteAmount,
    baseCurrency: input.baseCurrency,
    quoteCurrency: input.quoteCurrency,
    rateVersionId: input.rateVersionId,
  })

  const systemTemplate = findSystemMessageTemplate({
    key: eventKey,
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
  })

  try {
    const resolved = await resolveMessageTemplate({
      accountId: input.accountId,
      eventKey,
      audience: 'customer',
      channel: 'whatsapp',
      locale: input.locale ?? 'ar',
      store: input.store,
    })
    assertFxTradeCustomerTemplate(resolved.template)
    return {
      text: renderMessageTemplate({ template: resolved.template, context }),
      source: resolved.source,
      eventKey: resolved.resolvedEventKey,
      resolvedLocale: resolved.resolvedLocale,
      ...(resolved.revisionId ? { revisionId: resolved.revisionId } : {}),
      ...(resolved.version != null ? { version: resolved.version } : {}),
    }
  } catch (error) {
    if (systemTemplate) {
      try {
        assertFxTradeCustomerTemplate(systemTemplate)
        return {
          text: renderMessageTemplate({ template: systemTemplate, context }),
          source: 'system',
          eventKey,
          resolvedLocale: systemTemplate.locale,
          fallbackReason: safeReason(error),
        }
      } catch {
        // Emergency copy below still uses only the authoritative request snapshot.
      }
    }

    return {
      text: emergencyMessage(input),
      source: 'emergency',
      eventKey,
      resolvedLocale: 'ar',
      fallbackReason: safeReason(error),
    }
  }
}

function assertFxTradeCustomerTemplate(template: MessageTemplateDefinition): void {
  if (template.audience !== 'customer' || template.channel !== 'whatsapp') {
    throw new Error('FX_TRADE_TEMPLATE_SURFACE_MISMATCH')
  }
  if ((template.secretVariables ?? []).length > 0 || template.body.includes('{{secret.')) {
    throw new Error('FX_TRADE_TEMPLATE_SECRETS_FORBIDDEN')
  }
  for (const placeholder of REQUIRED_FINANCIAL_PLACEHOLDERS) {
    if (!template.body.includes(placeholder)) {
      throw new Error(`FX_TRADE_TEMPLATE_FINANCIAL_FACT_REQUIRED:${placeholder}`)
    }
  }
}

function emergencyMessage(input: FxTradeCustomerMessageInput): string {
  const state =
    input.outcome === 'pending_admin'
      ? '🕓 تم استلام طلب الصرف وهو بانتظار المراجعة.'
      : input.outcome === 'approved_for_contact'
        ? '✅ تم قبول طلب الصرف. ستتواصل معك الإدارة في أقرب وقت لمتابعة التنفيذ. لم يتم تسجيل العملية كمكتملة بعد.'
        : input.outcome === 'rejected'
          ? '⛔ تمت مراجعة طلب الصرف ولم يتم اعتماده.'
          : '✅ تم إتمام عملية الصرف.'
  const sideLabel = input.side === 'customer_buy' ? `شراء ${input.baseCurrency}` : `بيع ${input.baseCurrency}`
  const requestedCurrency = input.amountBasis === 'base' ? input.baseCurrency : input.quoteCurrency
  return [
    state,
    `المرجع: ${input.reference}`,
    `الزوج: ${input.baseCurrency}/${input.quoteCurrency}`,
    `العملية: ${sideLabel}`,
    `المبلغ المطلوب: ${formatMessageNumber(input.requestedAmount)} ${requestedCurrency}`,
    `السعر الفعلي: ${formatMessageNumber(input.effectiveRate)} ${input.quoteCurrency} لكل ${input.baseCurrency}`,
    `المبلغ الأساسي: ${formatMessageNumber(input.baseAmount)} ${input.baseCurrency}`,
    `المبلغ المقابل: ${formatMessageNumber(input.quoteAmount)} ${input.quoteCurrency}`,
  ].join('\n')
}

function safeReason(error: unknown): string {
  if (!(error instanceof Error)) return 'FX_TRADE_TEMPLATE_UNAVAILABLE'
  const known = [
    'FX_TRADE_TEMPLATE_SURFACE_MISMATCH',
    'FX_TRADE_TEMPLATE_SECRETS_FORBIDDEN',
    'FX_TRADE_TEMPLATE_FINANCIAL_FACT_REQUIRED',
    'MESSAGE_TEMPLATE_REQUIRED_VARIABLE_MISSING',
    'MESSAGE_TEMPLATE_VARIABLE_MISSING',
    'MESSAGE_TEMPLATE_TOO_LONG',
    'MESSAGE_TEMPLATE_NOT_FOUND',
  ]
  return known.find((code) => error.message.includes(code)) ?? 'FX_TRADE_TEMPLATE_UNAVAILABLE'
}
