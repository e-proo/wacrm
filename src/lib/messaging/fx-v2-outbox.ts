import { supabaseAdmin } from '@/lib/ai/admin-client'
import {
  renderFxTradeCustomerMessage,
  type FxTradeCustomerOutcome,
} from './fx-v2-customer'
import { createSupabaseTemplateOverrideStore } from './supabase-store'

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
 * Renders an FX V2 outbox event from authoritative immutable trade facts.
 * The outbox row stores only the stable business-event key; customer-facing
 * text is resolved at delivery time through the shared messaging platform.
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

  const db = supabaseAdmin()
  const { data: trade, error: tradeError } = await db
    .from('exchange_trade_requests')
    .select(
      'id, code, pair_id, side, amount_basis, requested_amount, effective_rate, base_amount, quote_amount, rate_version_id',
    )
    .eq('account_id', input.accountId)
    .eq('id', input.tradeRequestId)
    .maybeSingle()
  if (tradeError) throw tradeError
  if (!trade) throw new Error('FX_TRADE_NOTIFICATION_REQUEST_NOT_FOUND')

  const { data: pair, error: pairError } = await db
    .from('exchange_rate_pairs')
    .select('base_currency_id, quote_currency_id')
    .eq('account_id', input.accountId)
    .eq('id', trade.pair_id)
    .maybeSingle()
  if (pairError) throw pairError
  if (!pair) throw new Error('FX_TRADE_NOTIFICATION_PAIR_NOT_FOUND')

  const currencyIds = [pair.base_currency_id, pair.quote_currency_id]
  const { data: currencies, error: currencyError } = await db
    .from('currencies')
    .select('id, code')
    .eq('account_id', input.accountId)
    .in('id', currencyIds)
  if (currencyError) throw currencyError

  const codes = new Map(
    (currencies ?? []).map((currency) => [currency.id, currency.code] as const),
  )
  const baseCurrency = codes.get(pair.base_currency_id)
  const quoteCurrency = codes.get(pair.quote_currency_id)
  if (!baseCurrency || !quoteCurrency) {
    throw new Error('FX_TRADE_NOTIFICATION_CURRENCY_NOT_FOUND')
  }

  const rendered = await renderFxTradeCustomerMessage({
    accountId: input.accountId,
    outcome,
    requestId: trade.id,
    reference: `FX-${trade.code}`,
    side: trade.side as 'customer_buy' | 'customer_sell',
    amountBasis: trade.amount_basis as 'base' | 'quote',
    requestedAmount: String(trade.requested_amount),
    effectiveRate: String(trade.effective_rate),
    baseAmount: String(trade.base_amount),
    quoteAmount: String(trade.quote_amount),
    baseCurrency,
    quoteCurrency,
    rateVersionId: String(trade.rate_version_id),
    store: createSupabaseTemplateOverrideStore(db),
  })

  console.info(
    [
      `[messaging] event=${rendered.eventKey}`,
      `source=${rendered.source}`,
      `template=${rendered.eventKey}`,
      `locale=${rendered.resolvedLocale}`,
      'channel=whatsapp',
      `entity=${trade.id}`,
      rendered.revisionId ? `revision=${rendered.revisionId}` : null,
      rendered.version != null ? `version=${rendered.version}` : null,
      rendered.fallbackReason ? `fallback=${rendered.fallbackReason}` : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' '),
  )

  return rendered.text
}
