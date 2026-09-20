import { supabaseAdmin } from '@/lib/ai/admin-client'

export interface FxTradeMessageFacts {
  id: string
  code: string
  side: 'customer_buy' | 'customer_sell'
  amountBasis: 'base' | 'quote'
  requestedAmount: string
  effectiveRate: string
  baseAmount: string
  quoteAmount: string
  rateVersionId: string
  baseCurrency: string
  quoteCurrency: string
}

export async function loadFxTradeMessageFacts(input: {
  accountId: string
  tradeRequestId: string
}): Promise<FxTradeMessageFacts> {
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

  return {
    id: String(trade.id),
    code: String(trade.code),
    side: trade.side as 'customer_buy' | 'customer_sell',
    amountBasis: trade.amount_basis as 'base' | 'quote',
    requestedAmount: String(trade.requested_amount),
    effectiveRate: String(trade.effective_rate),
    baseAmount: String(trade.base_amount),
    quoteAmount: String(trade.quote_amount),
    rateVersionId: String(trade.rate_version_id),
    baseCurrency,
    quoteCurrency,
  }
}
