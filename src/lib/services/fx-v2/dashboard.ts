import { supabaseAdmin } from '@/lib/ai/admin-client'
import {
  getCurrentFxRateByPair,
  getFxBaseCurrency,
  listFxPairs,
  type FxCurrencyRef,
  type FxPair,
} from './service'

export interface FxDashboardCurrency extends FxCurrencyRef {
  kind: 'iso_4217' | 'historical' | 'local'
}

export interface FxDashboardPair {
  pair: FxPair
  currentRate: {
    rateVersionId: string
    versionNumber: number
    businessBuyRate: string
    businessSellRate: string
    source: 'manual' | 'admin_agent' | 'external' | 'migration'
    publishedAt: string
  } | null
}

export interface FxRateHistoryRow {
  id: string
  pairId: string
  versionNumber: number
  businessBuyRate: string
  businessSellRate: string
  source: 'manual' | 'admin_agent' | 'external' | 'migration'
  sourceChangeRequestId: string | null
  notesInternal: string | null
  publishedAt: string
  createdAt: string
}

export type FxTradeRequestStatus =
  | 'pending_admin'
  | 'approved_for_contact'
  | 'rejected'
  | 'completed'
  | 'cancelled'

export interface FxTradeRequestRow {
  id: string
  code: string
  pair: FxPair
  side: 'customer_buy' | 'customer_sell'
  amountBasis: 'base' | 'quote'
  requestedAmount: string
  rateVersionId: string
  effectiveRate: string
  baseAmount: string
  quoteAmount: string
  status: FxTradeRequestStatus
  contactId: string | null
  conversationId: string | null
  decisionChangeRequestId: string | null
  decisionNote: string | null
  decidedAt: string | null
  completedAt: string | null
  cancelledAt: string | null
  createdAt: string
  updatedAt: string
}

export async function listFxDashboardCurrencies(
  accountId: string,
): Promise<FxDashboardCurrency[]> {
  const { data, error } = await supabaseAdmin()
    .from('currencies')
    .select('id, code, display_name, symbol, decimal_digits, status, kind')
    .eq('account_id', accountId)
    .order('code', { ascending: true })
  if (error) throw error

  return (data ?? []).map((row) => ({
    id: String(row.id),
    code: String(row.code),
    displayName: String(row.display_name),
    symbol: row.symbol === null ? null : String(row.symbol),
    decimalDigits: Number(row.decimal_digits),
    status: row.status as FxCurrencyRef['status'],
    kind: row.kind as FxDashboardCurrency['kind'],
  }))
}

export async function getFxDashboardOverview(accountId: string): Promise<{
  baseCurrency: FxCurrencyRef | null
  currencies: FxDashboardCurrency[]
  pairs: FxDashboardPair[]
}> {
  const [baseCurrency, currencies, pairs] = await Promise.all([
    getFxBaseCurrency(accountId),
    listFxDashboardCurrencies(accountId),
    listFxPairs(accountId),
  ])

  const withRates = await Promise.all(
    pairs.map(async (pair) => {
      const current = await getCurrentFxRateByPair(accountId, pair)
      return {
        pair,
        currentRate: current
          ? {
              rateVersionId: current.rateVersionId,
              versionNumber: current.versionNumber,
              businessBuyRate: current.businessBuyRate,
              businessSellRate: current.businessSellRate,
              source: current.source,
              publishedAt: current.publishedAt,
            }
          : null,
      }
    }),
  )

  return { baseCurrency, currencies, pairs: withRates }
}

export async function listFxRateHistory(
  accountId: string,
  pairId: string,
  limit = 50,
): Promise<FxRateHistoryRow[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200)
  const { data, error } = await supabaseAdmin()
    .from('exchange_rate_versions')
    .select(
      'id, pair_id, version_number, business_buy_rate, business_sell_rate, source, source_change_request_id, notes_internal, published_at, created_at',
    )
    .eq('account_id', accountId)
    .eq('pair_id', pairId)
    .order('version_number', { ascending: false })
    .limit(safeLimit)
  if (error) throw error

  return (data ?? []).map((row) => ({
    id: String(row.id),
    pairId: String(row.pair_id),
    versionNumber: Number(row.version_number),
    businessBuyRate: String(row.business_buy_rate),
    businessSellRate: String(row.business_sell_rate),
    source: row.source as FxRateHistoryRow['source'],
    sourceChangeRequestId:
      row.source_change_request_id === null
        ? null
        : String(row.source_change_request_id),
    notesInternal: row.notes_internal === null ? null : String(row.notes_internal),
    publishedAt: String(row.published_at),
    createdAt: String(row.created_at),
  }))
}

export async function listFxTradeRequests(
  accountId: string,
  options: { status?: FxTradeRequestStatus | null; limit?: number } = {},
): Promise<FxTradeRequestRow[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 250)
  let query = supabaseAdmin()
    .from('exchange_trade_requests')
    .select(
      'id, code, pair_id, side, amount_basis, requested_amount, rate_version_id, effective_rate, base_amount, quote_amount, status, contact_id, conversation_id, decision_change_request_id, decision_note, decided_at, completed_at, cancelled_at, created_at, updated_at',
    )
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(safeLimit)

  if (options.status) query = query.eq('status', options.status)

  const { data, error } = await query
  if (error) throw error
  const rows = data ?? []
  if (rows.length === 0) return []

  const pairs = await listFxPairs(accountId, { includeArchived: true })
  const pairMap = new Map(pairs.map((pair) => [pair.id, pair] as const))

  return rows.map((row) => {
    const pair = pairMap.get(String(row.pair_id))
    if (!pair) {
      throw new Error(`FX trade request references missing pair ${String(row.pair_id)}`)
    }
    return {
      id: String(row.id),
      code: String(row.code),
      pair,
      side: row.side as FxTradeRequestRow['side'],
      amountBasis: row.amount_basis as FxTradeRequestRow['amountBasis'],
      requestedAmount: String(row.requested_amount),
      rateVersionId: String(row.rate_version_id),
      effectiveRate: String(row.effective_rate),
      baseAmount: String(row.base_amount),
      quoteAmount: String(row.quote_amount),
      status: row.status as FxTradeRequestStatus,
      contactId: row.contact_id === null ? null : String(row.contact_id),
      conversationId:
        row.conversation_id === null ? null : String(row.conversation_id),
      decisionChangeRequestId:
        row.decision_change_request_id === null
          ? null
          : String(row.decision_change_request_id),
      decisionNote: row.decision_note === null ? null : String(row.decision_note),
      decidedAt: row.decided_at === null ? null : String(row.decided_at),
      completedAt: row.completed_at === null ? null : String(row.completed_at),
      cancelledAt: row.cancelled_at === null ? null : String(row.cancelled_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  })
}
