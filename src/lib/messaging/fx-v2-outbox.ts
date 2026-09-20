import {
  renderFxTradeCustomerMessage,
  type FxTradeCustomerOutcome,
} from './fx-v2-customer'
import { createSupabaseTemplateOverrideStore } from './supabase-store'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadFxTradeMessageFacts } from '@/lib/services/fx-v2/message-facts'

export function fxOutcomeForBusinessEvent(eventType: string): FxTradeCustomerOutcome | null {
  switch (eventType) {
    case 'exchange_rate.trade.requested':
      return 'pending_admin'
    case 'exchange_rate.trade.approved':
      return 'approved_for_contact'
    case 'exchange_rate.trade.rejected':
      return 'rejected'
    case 'exchange_rate.trade.completed':
      return 'completed'
    default:
      return null
  }
}

/**
 * Legacy active renderer retained during Phase F shadow verification.
 * Business facts are loaded through the same domain-owned immutable fact loader
 * used by the new Event Projector, preventing two competing FX read models.
 */
export async function renderFxTradeBusinessEventText(input: {
  accountId: string
  tradeRequestId: string
  eventType: string
}): Promise<string> {
  const outcome = fxOutcomeForBusinessEvent(input.eventType)
  if (!outcome) {
    throw new Error(`FX_TRADE_NOTIFICATION_EVENT_UNSUPPORTED:${input.eventType}`)
  }

  const facts = await loadFxTradeMessageFacts({
    accountId: input.accountId,
    tradeRequestId: input.tradeRequestId,
  })
  const db = supabaseAdmin()

  const rendered = await renderFxTradeCustomerMessage({
    accountId: input.accountId,
    outcome,
    requestId: facts.id,
    reference: `FX-${facts.code}`,
    side: facts.side,
    amountBasis: facts.amountBasis,
    requestedAmount: facts.requestedAmount,
    effectiveRate: facts.effectiveRate,
    baseAmount: facts.baseAmount,
    quoteAmount: facts.quoteAmount,
    baseCurrency: facts.baseCurrency,
    quoteCurrency: facts.quoteCurrency,
    rateVersionId: facts.rateVersionId,
    store: createSupabaseTemplateOverrideStore(db),
  })

  console.info(
    [
      `[messaging] event=${rendered.eventKey}`,
      `source=${rendered.source}`,
      `template=${rendered.eventKey}`,
      `locale=${rendered.resolvedLocale}`,
      'channel=whatsapp',
      `entity=${facts.id}`,
      rendered.revisionId ? `revision=${rendered.revisionId}` : null,
      rendered.version != null ? `version=${rendered.version}` : null,
      rendered.fallbackReason ? `fallback=${rendered.fallbackReason}` : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' '),
  )

  return rendered.text
}
