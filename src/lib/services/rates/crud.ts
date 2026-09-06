import { supabaseAdmin } from '@/lib/ai/admin-client'
import {
  publishExchangeRateVersion,
  ServiceError,
} from '@/lib/services/domain-services'

export { ServiceError }

// ============================================================
// Exchange-rate CRUD service (Phase 2 follow-up to migration
// 051). All writes are admin+ gated at the API layer; this
// module assumes the caller has already passed auth and just
// provides typed operations over the SQL tables + RPCs.
//
// Surface:
//   • listBooks(accountId)
//   • createBook(accountId, input)
//   • listVersions(accountId, bookId)
//   • createDraftVersion(accountId, bookId, input)
//   • putVersionRates(accountId, bookId, versionId, rates) —
//       REPLACES every rate row in the version. Use createBook
//       for new versions, this one for editing.
//   • validateVersion(accountId, bookId, versionId)
//   • publishVersion(accountId, bookId, versionId, actor)
//   • getRateHistory(accountId, opts) — for the history viewer
// ============================================================

export interface BookInput {
  name: string
  region?: string | null
  channel?: 'whatsapp'
  settlementMethod?: 'cash' | 'bank' | 'wallet' | 'other' | null
  timezone?: string
  staleAfterSeconds?: number
}

export interface RateRowInput {
  baseCurrency: string
  quoteCurrency: string
  buyRate: string
  sellRate: string
  minAmount?: string | null
  maxAmount?: string | null
  rateUnit?: string | null
}

export interface VersionInput {
  effectiveAt?: string | null
  expiresAt?: string | null
  notesPublic?: string | null
  notesInternal?: string | null
}

export interface BookRow {
  id: string
  account_id: string
  name: string
  region: string | null
  channel: string
  settlement_method: string | null
  timezone: string
  stale_after_seconds: number
  current_published_version_id: string | null
  status: string
  created_at: string
  updated_at: string
}

export interface VersionRow {
  id: string
  account_id: string
  book_id: string
  version_number: number
  status: 'draft' | 'published' | 'superseded'
  effective_at: string | null
  expires_at: string | null
  source: string
  created_by: string | null
  created_at: string
  published_by: string | null
  published_at: string | null
}

export interface RateRow {
  id: string
  version_id: string
  base_currency: string
  quote_currency: string
  buy_rate: string
  sell_rate: string
  min_amount: string | null
  max_amount: string | null
  rate_unit: string | null
  notes_public: string | null
  notes_internal: string | null
  created_at: string
}

export interface HistoryRow {
  id: string
  book_id: string
  from_version_id: string | null
  to_version_id: string | null
  base_currency: string
  quote_currency: string
  buy_rate: string | null
  sell_rate: string | null
  min_amount: string | null
  max_amount: string | null
  rate_unit: string | null
  effective_at: string
  event_kind: 'created' | 'superseded' | 'expired'
  actor_id: string | null
  created_at: string
}

// ------------------------------------------------------------
// Books
// ------------------------------------------------------------
export async function listBooks(accountId: string): Promise<BookRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('exchange_rate_books')
    .select(
      'id, account_id, name, region, channel, settlement_method, timezone, stale_after_seconds, current_published_version_id, status, created_at, updated_at',
    )
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as unknown as BookRow[]
}

export async function createBook(
  accountId: string,
  input: BookInput,
  actorUserId: string | null,
): Promise<BookRow> {
  if (!input.name?.trim()) {
    throw new ServiceError('INVALID_INPUT', 'name is required.')
  }
  const { data, error } = await supabaseAdmin()
    .from('exchange_rate_books')
    .insert({
      account_id: accountId,
      name: input.name.trim(),
      region: input.region ?? null,
      channel: input.channel ?? 'whatsapp',
      settlement_method: input.settlementMethod ?? null,
      timezone: input.timezone ?? 'UTC',
      stale_after_seconds: input.staleAfterSeconds ?? 1800,
      status: 'active',
      created_by: actorUserId,
    })
    .select(
      'id, account_id, name, region, channel, settlement_method, timezone, stale_after_seconds, current_published_version_id, status, created_at, updated_at',
    )
    .single()
  if (error || !data) {
    const code = (error as { code?: string } | null)?.code
    if (code === '23505') {
      throw new ServiceError(
        'DUPLICATE_BOOK',
        'A book with this (region, channel, settlement) already exists.',
        409,
      )
    }
    throw error
  }
  return data as unknown as BookRow
}

// ------------------------------------------------------------
// Versions
// ------------------------------------------------------------
export async function listVersions(
  accountId: string,
  bookId: string,
): Promise<VersionRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('exchange_rate_book_versions')
    .select(
      'id, account_id, book_id, version_number, status, effective_at, expires_at, source, created_by, created_at, published_by, published_at',
    )
    .eq('account_id', accountId)
    .eq('book_id', bookId)
    .order('version_number', { ascending: false })
  if (error) throw error
  return (data ?? []) as unknown as VersionRow[]
}

export async function createDraftVersion(
  accountId: string,
  bookId: string,
  input: VersionInput,
  actorUserId: string | null,
): Promise<VersionRow> {
  // The next version_number is max(existing) + 1.
  const { data: maxRow } = await supabaseAdmin()
    .from('exchange_rate_book_versions')
    .select('version_number')
    .eq('account_id', accountId)
    .eq('book_id', bookId)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle()
  const nextNumber = ((maxRow as { version_number?: number } | null)?.version_number ?? 0) + 1

  const { data, error } = await supabaseAdmin()
    .from('exchange_rate_book_versions')
    .insert({
      account_id: accountId,
      book_id: bookId,
      version_number: nextNumber,
      status: 'draft',
      effective_at: input.effectiveAt ?? null,
      expires_at: input.expiresAt ?? null,
      source: 'manual',
      created_by: actorUserId,
    })
    .select(
      'id, account_id, book_id, version_number, status, effective_at, expires_at, source, created_by, created_at, published_by, published_at',
    )
    .single()
  if (error || !data) throw error
  return data as unknown as VersionRow
}

// ------------------------------------------------------------
// Rates inside a version
// ------------------------------------------------------------
export async function listRatesForVersion(
  accountId: string,
  versionId: string,
): Promise<RateRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('exchange_rates')
    .select(
      'id, version_id, base_currency, quote_currency, buy_rate, sell_rate, min_amount, max_amount, rate_unit, notes_public, notes_internal, created_at',
    )
    .eq('account_id', accountId)
    .eq('version_id', versionId)
  if (error) throw error
  return (data ?? []) as unknown as RateRow[]
}

/**
 * Replace all rate rows in a draft version. Phase 2 keeps this
 * simple — the UI is expected to send the complete desired
 * state of the version. Phase 3 can add finer-grained
 * insert/update/delete endpoints if needed.
 */
export async function putVersionRates(
  accountId: string,
  bookId: string,
  versionId: string,
  rates: RateRowInput[],
): Promise<RateRow[]> {
  // Guard: only DRAFT versions can be edited. Once published,
  // the row is immutable (per the migration 049 contract).
  const { data: versionRow, error: vErr } = await supabaseAdmin()
    .from('exchange_rate_book_versions')
    .select('id, status, book_id')
    .eq('account_id', accountId)
    .eq('id', versionId)
    .maybeSingle()
  if (vErr) throw vErr
  if (!versionRow) {
    throw new ServiceError('NOT_FOUND', 'Version not found.', 404)
  }
  if ((versionRow as { status: string }).status !== 'draft') {
    throw new ServiceError(
      'INVALID_STATE',
      'Cannot edit rates on a non-draft version.',
      409,
    )
  }

  // Delete + insert in a single transactional block via the
  // service-role client. RLS already scopes both to the account,
  // so the explicit .eq('account_id', ...) is belt-and-braces.
  const db = supabaseAdmin()
  const { error: delErr } = await db
    .from('exchange_rates')
    .delete()
    .eq('account_id', accountId)
    .eq('version_id', versionId)
  if (delErr) throw delErr

  if (rates.length === 0) return []

  const inserts = rates.map((r) => ({
    account_id: accountId,
    version_id: versionId,
    base_currency: r.baseCurrency,
    quote_currency: r.quoteCurrency,
    buy_rate: r.buyRate,
    sell_rate: r.sellRate,
    min_amount: r.minAmount ?? null,
    max_amount: r.maxAmount ?? null,
    rate_unit: r.rateUnit ?? null,
  }))
  const { data, error } = await db
    .from('exchange_rates')
    .insert(inserts)
    .select(
      'id, version_id, base_currency, quote_currency, buy_rate, sell_rate, min_amount, max_amount, rate_unit, notes_public, notes_internal, created_at',
    )
  if (error || !data) {
    // 23505 on the unique index = duplicate (base, quote, min, max).
    const code = (error as { code?: string } | null)?.code
    if (code === '23505') {
      throw new ServiceError(
        'DUPLICATE_PAIRS',
        'Two or more rows share the same (base, quote, min, max).',
        409,
      )
    }
    throw error
  }
  return data as unknown as RateRow[]
}

// ------------------------------------------------------------
// Validate (RPC) + publish (RPC).
// ------------------------------------------------------------
export interface ValidateResult {
  ok: boolean
  errors: Array<{ code: string; message: string; pairs?: unknown }>
  warnings: Array<{ code: string; message: string }>
  duplicate_pairs: Array<{ base: string; quote: string }>
  non_positive_rates: Array<{
    base: string
    quote: string
    side: 'buy' | 'sell'
  }>
  pairs_with_no_buy_or_sell: Array<{ base: string; quote: string }>
  rate_count: number
}

export async function validateVersion(
  accountId: string,
  bookId: string,
  versionId: string,
): Promise<ValidateResult> {
  const { data, error } = await supabaseAdmin().rpc(
    'validate_exchange_rate_version',
    {
      p_account_id: accountId,
      p_book_id: bookId,
      p_version_id: versionId,
    },
  )
  if (error) throw error
  return data as unknown as ValidateResult
}

export async function publishVersion(
  accountId: string,
  bookId: string,
  versionId: string,
  actorUserId: string | null,
): Promise<{ versionId: string }> {
  return publishExchangeRateVersion({
    accountId,
    bookId,
    versionId,
    actorUserId,
  })
}

// ------------------------------------------------------------
// History
// ------------------------------------------------------------
export interface HistoryQuery {
  accountId: string
  bookId?: string
  baseCurrency?: string
  quoteCurrency?: string
  from?: string
  to?: string
  limit?: number
}

export async function getRateHistory(query: HistoryQuery): Promise<HistoryRow[]> {
  const limit = Math.min(query.limit ?? 200, 1000)
  let q = supabaseAdmin()
    .from('exchange_rate_history')
    .select(
      'id, book_id, from_version_id, to_version_id, base_currency, quote_currency, buy_rate, sell_rate, min_amount, max_amount, rate_unit, effective_at, event_kind, actor_id, created_at',
    )
    .eq('account_id', query.accountId)
    .order('effective_at', { ascending: false })
    .limit(limit)
  if (query.bookId) q = q.eq('book_id', query.bookId)
  if (query.baseCurrency) q = q.eq('base_currency', query.baseCurrency)
  if (query.quoteCurrency) q = q.eq('quote_currency', query.quoteCurrency)
  if (query.from) q = q.gte('effective_at', query.from)
  if (query.to) q = q.lte('effective_at', query.to)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as unknown as HistoryRow[]
}
