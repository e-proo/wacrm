import {
  buildFxTradeMessageContext,
  formatMessageNumber,
} from '@/lib/messaging/domains'
import type {
  BusinessEventMessageProjection,
  BusinessEventProjectionInput,
  EventProjectorRegistration,
} from '@/lib/services/platform/event-projector-registry'
import {
  loadFxTradeMessageFacts,
  type FxTradeMessageFacts,
} from './message-facts'

const FX_REQUIRED_PLACEHOLDERS = [
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

const OUTCOME_BY_EVENT = {
  'exchange_rate.trade.requested': 'pending_admin',
  'exchange_rate.trade.approved': 'approved_for_contact',
  'exchange_rate.trade.rejected': 'rejected',
  'exchange_rate.trade.completed': 'completed',
} as const

type FxEventType = keyof typeof OUTCOME_BY_EVENT

export function buildFxTradeBusinessEventProjection(input: {
  eventType: FxEventType
  subjectType: string
  subjectId: string
  facts: FxTradeMessageFacts
}): BusinessEventMessageProjection {
  if (input.subjectType !== 'fx_trade_request') {
    throw new Error('FX_EVENT_SUBJECT_MISMATCH')
  }
  if (input.subjectId !== input.facts.id) {
    throw new Error('FX_EVENT_SUBJECT_ID_MISMATCH')
  }

  const outcome = OUTCOME_BY_EVENT[input.eventType]
  const facts = input.facts
  const reference = 'FX-' + facts.code
  const context = buildFxTradeMessageContext({
    entityId: facts.id,
    reference,
    status: outcome,
    side: facts.side,
    amountBasis: facts.amountBasis,
    requestedAmount: facts.requestedAmount,
    effectiveRate: facts.effectiveRate,
    baseAmount: facts.baseAmount,
    quoteAmount: facts.quoteAmount,
    baseCurrency: facts.baseCurrency,
    quoteCurrency: facts.quoteCurrency,
    rateVersionId: facts.rateVersionId,
  })

  const state =
    outcome === 'pending_admin'
      ? '🕓 تم استلام طلب الصرف وهو بانتظار المراجعة.'
      : outcome === 'approved_for_contact'
        ? '✅ تم قبول طلب الصرف. ستتواصل معك الإدارة في أقرب وقت لمتابعة التنفيذ. لم يتم تسجيل العملية كمكتملة بعد.'
        : outcome === 'rejected'
          ? '⛔ تمت مراجعة طلب الصرف ولم يتم اعتماده.'
          : '✅ تم إتمام عملية الصرف.'
  const sideLabel =
    facts.side === 'customer_buy'
      ? 'شراء ' + facts.baseCurrency
      : 'بيع ' + facts.baseCurrency
  const requestedCurrency =
    facts.amountBasis === 'base' ? facts.baseCurrency : facts.quoteCurrency

  return {
    eventKey: input.eventType,
    audience: 'customer',
    channel: 'whatsapp',
    locale: 'ar',
    context,
    templatePolicy: {
      forbidSecrets: true,
      requiredBodyPlaceholders: FX_REQUIRED_PLACEHOLDERS,
    },
    emergencyText: [
      state,
      'المرجع: ' + reference,
      'الزوج: ' + facts.baseCurrency + '/' + facts.quoteCurrency,
      'العملية: ' + sideLabel,
      'المبلغ المطلوب: ' +
        formatMessageNumber(facts.requestedAmount) +
        ' ' +
        requestedCurrency,
      'السعر الفعلي: ' +
        formatMessageNumber(facts.effectiveRate) +
        ' ' +
        facts.quoteCurrency +
        ' لكل ' +
        facts.baseCurrency,
      'المبلغ الأساسي: ' +
        formatMessageNumber(facts.baseAmount) +
        ' ' +
        facts.baseCurrency,
      'المبلغ المقابل: ' +
        formatMessageNumber(facts.quoteAmount) +
        ' ' +
        facts.quoteCurrency,
    ].join('\n'),
  }
}

const projectFxTradeEvent = async (
  input: BusinessEventProjectionInput,
): Promise<BusinessEventMessageProjection> => {
  if (!(input.eventType in OUTCOME_BY_EVENT)) {
    throw new Error('FX_EVENT_PROJECTOR_UNSUPPORTED')
  }
  const facts = await loadFxTradeMessageFacts({
    accountId: input.accountId,
    tradeRequestId: input.subjectId,
  })
  return buildFxTradeBusinessEventProjection({
    eventType: input.eventType as FxEventType,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    facts,
  })
}

export const FX_V2_EVENT_PROJECTORS: readonly EventProjectorRegistration[] = (
  Object.keys(OUTCOME_BY_EVENT) as FxEventType[]
).map((eventType) => ({
  eventType,
  eventVersion: 1,
  projector: projectFxTradeEvent,
}))
