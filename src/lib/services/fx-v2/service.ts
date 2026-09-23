import { supabaseAdmin } from '@/lib/ai/admin-client'
import { parseDecimal } from '@/lib/services/pricing/decimal'
import { DomainError } from '@/lib/services/platform/domain-error'
import { normalizeIdempotencyKey } from '@/lib/services/platform/idempotency'
import {
  findCurrencyByCode,
  getCurrenciesByIds as getCatalogCurrenciesByIds,
  getCurrency as getCatalogCurrency,
  normalizeCurrencyCode,
  type CurrencyRow,
} from '@/lib/services/currencies/crud'
import {
  calculateFxTrade,
  type FxAmountBasis,
  type FxTradeCalculation,
  type FxTradeSide,
} from './engine'

export class FxServiceError extends DomainError {
  constructor(code: string, message: string, status = 400) {
    super(code, message, status)
    this.name = 'FxServiceError'
  }
}

export interface FxCurrencyRef {
  id: string
  code: string
  displayName: string
  symbol: string | null
  decimalDigits: number
  status: 'active' | 'disabled'
}

export interface FxPair {
  id: string
  accountId: string
  base: FxCurrencyRef
  quote: FxCurrencyRef
  status: 'active' | 'archived'
  currentRateVersionId: string | null
  lockVersion: number
  createdAt: string
  updatedAt: string
}

export interface FxCurrentRate {
  pair: FxPair
  rateVersionId: string
  versionNumber: number
  businessBuyRate: string
  businessSellRate: string
  source: 'manual' | 'admin_agent' | 'external' | 'migration'
  publishedAt: string
}

export interface PublishFxRateInput {
  accountId: string
  pairId: string
  expectedLockVersion: number
  businessBuyRate: string
  businessSellRate: string
  source?: 'manual' | 'admin_agent' | 'external' | 'migration'
  sourceChangeRequestId?: string | null
  notesInternal?: string | null
  actorUserId: string | null
}

export interface PublishFxRateResult {
  versionId: string
  versionNumber: number
  lockVersion: number
  idempotent: boolean
}

export interface CreateFxTradeRequestInput {
  accountId: string
  pairId: string
  side: FxTradeSide
  amountBasis: FxAmountBasis
  requestedAmount: string
  idempotencyKey: string
  expectedRateVersionId?: string | null
  contactId?: string | null
  conversationId?: string | null
  metadata?: Record<string, unknown>
}

export interface FxTradeRequestMutationResult {
  requestId: string
  status: string
  idempotent: boolean
}

export interface CreateFxTradeRequestResult extends FxTradeRequestMutationResult {
  code: string
  rateVersionId: string
  effectiveRate: string
  baseAmount: string
  quoteAmount: string
}

function requireCurrencyCode(code: string): string {
  const value = normalizeCurrencyCode(code)
  if (!value) {
    throw new FxServiceError(
      'FX_INVALID_CURRENCY_CODE',
      'Currency code must be 3-8 uppercase letters or underscores.',
    )
  }
  return value
}

function currencyRef(row: CurrencyRow): FxCurrencyRef {
  return {
    id: row.id,
    code: row.code,
    displayName: row.display_name,
    symbol: row.symbol,
    decimalDigits: row.decimal_digits,
    status: row.status,
  }
}

async function getFxCurrencyByCode(
  accountId: string,
  code: string,
  activeOnly = true,
): Promise<FxCurrencyRef | null> {
  const normalized = requireCurrencyCode(code)
  const row = await findCurrencyByCode(accountId, normalized, {
    includeDisabled: !activeOnly,
  })
  return row ? currencyRef(row) : null
}

async function getFxCurrenciesByIds(
  accountId: string,
  ids: string[],
): Promise<Map<string, FxCurrencyRef>> {
  const rows = await getCatalogCurrenciesByIds(accountId, ids)
  return new Map(
    rows.map((row) => {
      const ref = currencyRef(row)
      return [ref.id, ref] as const
    }),
  )
}

function pairFromRow(
  row: Record<string, unknown>,
  currencies: Map<string, FxCurrencyRef>,
): FxPair {
  const baseId = String(row.base_currency_id)
  const quoteId = String(row.quote_currency_id)
  const base = currencies.get(baseId)
  const quote = currencies.get(quoteId)
  if (!base || !quote) {
    throw new FxServiceError(
      'FX_PAIR_CURRENCY_MISSING',
      'One or more currencies referenced by the pair are missing.',
      409,
    )
  }
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    base,
    quote,
    status: row.status as FxPair['status'],
    currentRateVersionId:
      row.current_rate_version_id === null
        ? null
        : String(row.current_rate_version_id),
    lockVersion: Number(row.lock_version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

export async function getFxBaseCurrency(
  accountId: string,
): Promise<FxCurrencyRef | null> {
  const { data: settings, error } = await supabaseAdmin()
    .from('account_exchange_settings')
    .select('base_currency_id')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw error
  if (!settings) return null

  const currency = await getCatalogCurrency(
    accountId,
    String((settings as { base_currency_id: string }).base_currency_id),
  )
  return currency ? currencyRef(currency) : null
}

export async function setFxBaseCurrency(
  accountId: string,
  currencyCode: string,
  actorUserId: string | null,
): Promise<FxCurrencyRef> {
  const currency = await getFxCurrencyByCode(accountId, currencyCode, true)
  if (!currency) {
    throw new FxServiceError(
      'FX_CURRENCY_NOT_FOUND',
      'Active currency not found in this account.',
      404,
    )
  }

  const { error } = await supabaseAdmin()
    .from('account_exchange_settings')
    .upsert(
      {
        account_id: accountId,
        base_currency_id: currency.id,
        created_by: actorUserId,
        updated_by: actorUserId,
      },
      { onConflict: 'account_id' },
    )
  if (error) throw error
  return currency
}

export async function listFxPairs(
  accountId: string,
  options: { includeArchived?: boolean } = {},
): Promise<FxPair[]> {
  let query = supabaseAdmin()
    .from('exchange_rate_pairs')
    .select(
      'id, account_id, base_currency_id, quote_currency_id, status, current_rate_version_id, lock_version, created_at, updated_at',
    )
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
  if (!options.includeArchived) query = query.eq('status', 'active')

  const { data, error } = await query
  if (error) throw error
  const rows = (data ?? []) as unknown as Record<string, unknown>[]
  const currencies = await getFxCurrenciesByIds(
    accountId,
    rows.flatMap((row) => [
      String(row.base_currency_id),
      String(row.quote_currency_id),
    ]),
  )
  return rows.map((row) => pairFromRow(row, currencies))
}

export async function ensureFxPair(
  accountId: string,
  baseCode: string,
  quoteCode: string,
  actorUserId: string | null,
): Promise<FxPair> {
  const base = await getFxCurrencyByCode(accountId, baseCode, true)
  const quote = await getFxCurrencyByCode(accountId, quoteCode, true)
  if (!base || !quote) {
    throw new FxServiceError(
      'FX_CURRENCY_NOT_FOUND',
      'Both currencies must be active in this account.',
      404,
    )
  }
  if (base.id === quote.id) {
    throw new FxServiceError(
      'FX_SAME_CURRENCY_PAIR',
      'Base and quote currencies must be different.',
    )
  }

  const db = supabaseAdmin()
  const { data: existing, error: existingError } = await db
    .from('exchange_rate_pairs')
    .select(
      'id, account_id, base_currency_id, quote_currency_id, status, current_rate_version_id, lock_version, created_at, updated_at',
    )
    .eq('account_id', accountId)
    .eq('base_currency_id', base.id)
    .eq('quote_currency_id', quote.id)
    .maybeSingle()
  if (existingError) throw existingError

  let row = existing as unknown as Record<string, unknown> | null
  if (row && row.status === 'archived') {
    const { data, error } = await db
      .from('exchange_rate_pairs')
      .update({ status: 'active', updated_by: actorUserId })
      .eq('account_id', accountId)
      .eq('id', String(row.id))
      .select(
        'id, account_id, base_currency_id, quote_currency_id, status, current_rate_version_id, lock_version, created_at, updated_at',
      )
      .single()
    if (error || !data) throw error
    row = data as unknown as Record<string, unknown>
  }

  if (!row) {
    const { data, error } = await db
      .from('exchange_rate_pairs')
      .insert({
        account_id: accountId,
        base_currency_id: base.id,
        quote_currency_id: quote.id,
        status: 'active',
        created_by: actorUserId,
        updated_by: actorUserId,
      })
      .select(
        'id, account_id, base_currency_id, quote_currency_id, status, current_rate_version_id, lock_version, created_at, updated_at',
      )
      .single()
    if (error || !data) throw error
    row = data as unknown as Record<string, unknown>
  }

  return pairFromRow(row, new Map([[base.id, base], [quote.id, quote]]))
}

export async function resolveFxPair(
  accountId: string,
  baseCode: string,
  quoteCode: string,
): Promise<FxPair | null> {
  const base = await getFxCurrencyByCode(accountId, baseCode, false)
  const quote = await getFxCurrencyByCode(accountId, quoteCode, false)
  if (!base || !quote) return null

  const { data, error } = await supabaseAdmin()
    .from('exchange_rate_pairs')
    .select(
      'id, account_id, base_currency_id, quote_currency_id, status, current_rate_version_id, lock_version, created_at, updated_at',
    )
    .eq('account_id', accountId)
    .eq('base_currency_id', base.id)
    .eq('quote_currency_id', quote.id)
    .eq('status', 'active')
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  return pairFromRow(
    data as unknown as Record<string, unknown>,
    new Map([[base.id, base], [quote.id, quote]]),
  )
}

export async function getCurrentFxRateByPair(
  accountId: string,
  pair: FxPair,
): Promise<FxCurrentRate | null> {
  if (!pair.currentRateVersionId) return null
  const { data, error } = await supabaseAdmin()
    .from('exchange_rate_versions')
    .select(
      'id, version_number, business_buy_rate, business_sell_rate, source, published_at',
    )
    .eq('account_id', accountId)
    .eq('pair_id', pair.id)
    .eq('id', pair.currentRateVersionId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const row = data as unknown as Record<string, unknown>
  return {
    pair,
    rateVersionId: String(row.id),
    versionNumber: Number(row.version_number),
    businessBuyRate: String(row.business_buy_rate),
    businessSellRate: String(row.business_sell_rate),
    source: row.source as FxCurrentRate['source'],
    publishedAt: String(row.published_at),
  }
}

export async function getCurrentFxRate(
  accountId: string,
  baseCode: string,
  quoteCode: string,
): Promise<FxCurrentRate | null> {
  const pair = await resolveFxPair(accountId, baseCode, quoteCode)
  if (!pair) return null
  return getCurrentFxRateByPair(accountId, pair)
}

export async function quoteFxTrade(input: {
  accountId: string
  baseCode: string
  quoteCode: string
  side: FxTradeSide
  amountBasis: FxAmountBasis
  requestedAmount: string
}): Promise<{
  pair: FxPair
  rateVersionId: string
  versionNumber: number
  calculation: FxTradeCalculation
}> {
  const current = await getCurrentFxRate(
    input.accountId,
    input.baseCode,
    input.quoteCode,
  )
  if (!current) {
    throw new FxServiceError(
      'FX_RATE_NOT_PUBLISHED',
      'No current FX rate is published for this pair.',
      404,
    )
  }

  return {
    pair: current.pair,
    rateVersionId: current.rateVersionId,
    versionNumber: current.versionNumber,
    calculation: calculateFxTrade({
      side: input.side,
      amountBasis: input.amountBasis,
      requestedAmount: input.requestedAmount,
      businessBuyRate: current.businessBuyRate,
      businessSellRate: current.businessSellRate,
      baseDecimalDigits: current.pair.base.decimalDigits,
      quoteDecimalDigits: current.pair.quote.decimalDigits,
    }),
  }
}

function positiveRate(value: string, code: string): string {
  const parsed = parseDecimal(value, { rejectZero: true })
  if (!parsed || parsed.isNegative()) {
    throw new FxServiceError(code, 'Rate must be a positive decimal.')
  }
  return parsed.toFixed(8)
}

const RPC_ERROR_CODES = [
  'FX_INVALID_BUY_RATE',
  'FX_INVALID_SELL_RATE',
  'FX_INVALID_RATE_SOURCE',
  'FX_CHANGE_REQUEST_NOT_FOUND',
  'FX_CHANGE_REQUEST_REUSED',
  'FX_PAIR_NOT_FOUND',
  'FX_PAIR_NOT_ACTIVE',
  'FX_PAIR_CURRENCY_DISABLED',
  'FX_PAIR_VERSION_CONFLICT',
  'FX_INVALID_TRADE_SIDE',
  'FX_INVALID_AMOUNT_BASIS',
  'FX_INVALID_TRADE_AMOUNT',
  'FX_INVALID_IDEMPOTENCY_KEY',
  'FX_INVALID_METADATA',
  'FX_IDEMPOTENCY_KEY_REUSED',
  'FX_CONTACT_NOT_FOUND',
  'FX_CONVERSATION_NOT_FOUND',
  'FX_CONVERSATION_CONTACT_MISMATCH',
  'FX_RATE_NOT_PUBLISHED',
  'FX_RATE_VERSION_CONFLICT',
  'FX_RATE_VERSION_NOT_FOUND',
  'FX_AMOUNT_ROUNDS_TO_ZERO',
  'FX_INVALID_DECISION',
  'FX_TRADE_REQUEST_NOT_FOUND',
  'FX_TRADE_ALREADY_DECIDED',
  'FX_TRADE_STATUS_CONFLICT',
] as const

function mapRpcError(error: unknown, fallback: string): never {
  const value = error as { code?: string; message?: string }
  const message = value?.message ?? fallback
  if (value?.code === 'P0001') {
    const known = RPC_ERROR_CODES.find((code) => message.includes(code))
    throw new FxServiceError(known ?? 'FX_OPERATION_FAILED', message, 409)
  }
  throw error
}

export async function publishFxRateVersion(
  input: PublishFxRateInput,
): Promise<PublishFxRateResult> {
  if (!Number.isSafeInteger(input.expectedLockVersion) || input.expectedLockVersion < 0) {
    throw new FxServiceError(
      'FX_INVALID_LOCK_VERSION',
      'expectedLockVersion must be a non-negative safe integer.',
    )
  }

  const { data, error } = await supabaseAdmin().rpc(
    'publish_exchange_rate_pair_version_v2',
    {
      p_account_id: input.accountId,
      p_pair_id: input.pairId,
      p_expected_lock_version: input.expectedLockVersion,
      p_business_buy_rate: positiveRate(input.businessBuyRate, 'FX_INVALID_BUY_RATE'),
      p_business_sell_rate: positiveRate(input.businessSellRate, 'FX_INVALID_SELL_RATE'),
      p_source: input.source ?? 'manual',
      p_source_change_request_id: input.sourceChangeRequestId ?? null,
      p_notes_internal: input.notesInternal ?? null,
      p_actor_user_id: input.actorUserId,
    },
  )
  if (error) mapRpcError(error, 'FX rate publication failed.')
  const row = data as Record<string, unknown>
  return {
    versionId: String(row.version_id),
    versionNumber: Number(row.version_number),
    lockVersion: Number(row.lock_version),
    idempotent: Boolean(row.idempotent),
  }
}

export async function createFxTradeRequest(
  input: CreateFxTradeRequestInput,
): Promise<CreateFxTradeRequestResult> {
  const amount = parseDecimal(input.requestedAmount, { rejectZero: true })
  if (!amount || amount.isNegative()) {
    throw new FxServiceError(
      'FX_INVALID_TRADE_AMOUNT',
      'requestedAmount must be a positive decimal.',
    )
  }
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey)
  if (!idempotencyKey) {
    throw new FxServiceError(
      'FX_INVALID_IDEMPOTENCY_KEY',
      'idempotencyKey must be at least 8 characters.',
    )
  }

  const { data, error } = await supabaseAdmin().rpc(
    'create_exchange_trade_request_v2',
    {
      p_account_id: input.accountId,
      p_pair_id: input.pairId,
      p_side: input.side,
      p_amount_basis: input.amountBasis,
      p_requested_amount: amount.toFixed(8),
      p_idempotency_key: idempotencyKey,
      p_expected_rate_version_id: input.expectedRateVersionId ?? null,
      p_contact_id: input.contactId ?? null,
      p_conversation_id: input.conversationId ?? null,
      p_metadata: input.metadata ?? {},
    },
  )
  if (error) mapRpcError(error, 'FX trade request creation failed.')
  const row = data as Record<string, unknown>
  return {
    requestId: String(row.request_id),
    code: String(row.code),
    rateVersionId: String(row.rate_version_id),
    effectiveRate: String(row.effective_rate),
    baseAmount: String(row.base_amount),
    quoteAmount: String(row.quote_amount),
    status: String(row.status),
    idempotent: Boolean(row.idempotent),
  }
}

export async function decideFxTradeRequest(input: {
  accountId: string
  requestId: string
  expectedStatus: 'pending_admin'
  decision: 'approve' | 'reject'
  changeRequestId?: string | null
  note?: string | null
  actorUserId: string | null
}): Promise<FxTradeRequestMutationResult> {
  const { data, error } = await supabaseAdmin().rpc(
    'decide_exchange_trade_request_v2',
    {
      p_account_id: input.accountId,
      p_request_id: input.requestId,
      p_expected_status: input.expectedStatus,
      p_decision: input.decision,
      p_change_request_id: input.changeRequestId ?? null,
      p_note: input.note ?? null,
      p_actor_user_id: input.actorUserId,
    },
  )
  if (error) mapRpcError(error, 'FX trade decision failed.')
  const row = data as Record<string, unknown>
  return {
    requestId: String(row.request_id),
    status: String(row.status),
    idempotent: Boolean(row.idempotent),
  }
}

async function simpleTradeTransition(
  rpc: 'complete_exchange_trade_request_v2' | 'cancel_exchange_trade_request_v2',
  input: { accountId: string; requestId: string; actorUserId: string | null },
): Promise<FxTradeRequestMutationResult> {
  const { data, error } = await supabaseAdmin().rpc(rpc, {
    p_account_id: input.accountId,
    p_request_id: input.requestId,
    p_actor_user_id: input.actorUserId,
  })
  if (error) mapRpcError(error, 'FX trade state transition failed.')
  const row = data as Record<string, unknown>
  return {
    requestId: String(row.request_id),
    status: String(row.status),
    idempotent: Boolean(row.idempotent),
  }
}

export function completeFxTradeRequest(input: {
  accountId: string
  requestId: string
  actorUserId: string | null
}): Promise<FxTradeRequestMutationResult> {
  return simpleTradeTransition('complete_exchange_trade_request_v2', input)
}

export function cancelFxTradeRequest(input: {
  accountId: string
  requestId: string
  actorUserId: string | null
}): Promise<FxTradeRequestMutationResult> {
  return simpleTradeTransition('cancel_exchange_trade_request_v2', input)
}
