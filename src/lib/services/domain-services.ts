import { Decimal } from 'decimal.js'

// Server-only by convention — see repositories.ts comment.
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { parseDecimal } from '@/lib/services/pricing/decimal'
import { calculateQuote, type QuoteResult } from '@/lib/services/pricing/engine'
import { evaluateStaleness } from '@/lib/services/rates/staleness'

// ============================================================
// Services-coverage-rates domain services (Phase 2).
//
// Thin wrappers that:
//   1. Validate inputs against a closed shape (caller has already
//      passed auth + RLS).
//   2. Use the service-role RPCs from migration 050 for the
//      concurrency-critical paths (publish, reserve, release).
//   3. Compute quotes in pure code (the engine knows nothing
//      about Postgres).
//
// We deliberately keep this layer thin — the real authority is
// SQL (RLS + atomic RPCs). The service layer is glue + validation.
// ============================================================

export class ServiceError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
    this.status = status
  }
}

export interface PublishPricingRuleInput {
  accountId: string
  ruleId: string
  actorUserId: string | null
}

/**
 * Publish a pricing rule (draft → published). No-op for already-
 * published rules.
 */
export async function publishPricingRule(
  input: PublishPricingRuleInput,
): Promise<{ id: string }> {
  const db = supabaseAdmin()
  const { data: rule, error } = await db
    .from('service_pricing_rules')
    .select('id, status')
    .eq('account_id', input.accountId)
    .eq('id', input.ruleId)
    .maybeSingle()
  if (error) throw error
  if (!rule) throw new ServiceError('NOT_FOUND', 'Pricing rule not found.', 404)
  if ((rule as { status: string }).status === 'published') {
    return { id: input.ruleId }
  }
  if ((rule as { status: string }).status !== 'draft') {
    throw new ServiceError(
      'INVALID_STATE',
      `Rule is in state "${(rule as { status: string }).status}", not draft.`,
      409,
    )
  }
  const { error: updErr } = await db
    .from('service_pricing_rules')
    .update({
      status: 'published',
      published_at: new Date().toISOString(),
      published_by: input.actorUserId,
    })
    .eq('account_id', input.accountId)
    .eq('id', input.ruleId)
    .eq('status', 'draft')
  if (updErr) throw updErr
  return { id: input.ruleId }
}

export interface ReserveCoverageMatchInput {
  accountId: string
  offerId: string
  requestId: string
  matchedAmount: string
  currency: string
  idempotencyKey: string
  reservedUntil?: string | null
  rateSnapshot?: Record<string, unknown>
  feeSnapshot?: Record<string, unknown>
  providerCost?: string | null
  customerFee?: string | null
  actorUserId: string | null
}

/**
 * Reserve a coverage match — the critical atomic primitive. Two
 * concurrent callers racing for the last unit MUST result in
 * exactly one success (the SQL RPC enforces this).
 */
export async function reserveCoverageMatch(
  input: ReserveCoverageMatchInput,
): Promise<{ matchId: string }> {
  const amount = parseDecimal(input.matchedAmount, { rejectZero: true })
  if (!amount) {
    throw new ServiceError(
      'INVALID_AMOUNT',
      'matchedAmount must be a positive decimal string.',
    )
  }
  if (!input.idempotencyKey || input.idempotencyKey.length < 8) {
    throw new ServiceError(
      'INVALID_IDEMPOTENCY_KEY',
      'idempotencyKey must be at least 8 characters.',
    )
  }
  const { data, error } = await supabaseAdmin().rpc('reserve_coverage_match', {
    p_account_id: input.accountId,
    p_offer_id: input.offerId,
    p_request_id: input.requestId,
    p_matched_amount: amount.toString(),
    p_currency: input.currency,
    p_idempotency_key: input.idempotencyKey,
    p_reserved_until: input.reservedUntil ?? null,
    p_rate_snapshot: input.rateSnapshot ?? {},
    p_fee_snapshot: input.feeSnapshot ?? {},
    p_provider_cost: input.providerCost ? parseDecimal(input.providerCost)?.toString() ?? null : null,
    p_customer_fee: input.customerFee ? parseDecimal(input.customerFee)?.toString() ?? null : null,
    p_actor_user_id: input.actorUserId,
  })
  if (error) {
    const code = (error as { code?: string }).code
    // Map known RPC errors to typed ServiceError.
    if (code === 'P0001') {
      const msg = (error as { message?: string }).message ?? 'Booking failed'
      throw new ServiceError(mapRpcErrorCode(msg), msg, 409)
    }
    throw error
  }
  return { matchId: data as string }
}

export async function releaseCoverageMatch(input: {
  accountId: string
  matchId: string
  actorUserId: string | null
}): Promise<void> {
  const { error } = await supabaseAdmin().rpc('release_coverage_match', {
    p_account_id: input.accountId,
    p_match_id: input.matchId,
    p_actor_user_id: input.actorUserId,
  })
  if (error) throw error
}

function mapRpcErrorCode(msg: string): string {
  // The RPC raises plain exception messages — map them back to
  // the typed code names defined in migration 050.
  if (msg.includes('COVERAGE_OFFER_NOT_FOUND')) return 'COVERAGE_OFFER_NOT_FOUND'
  if (msg.includes('COVERAGE_REQUEST_NOT_FOUND')) return 'COVERAGE_REQUEST_NOT_FOUND'
  if (msg.includes('COVERAGE_SERVICE_MISMATCH')) return 'COVERAGE_SERVICE_MISMATCH'
  if (msg.includes('COVERAGE_CURRENCY_MISMATCH')) return 'COVERAGE_CURRENCY_MISMATCH'
  if (msg.includes('COVERAGE_OFFER_NOT_BOOKABLE')) return 'COVERAGE_OFFER_NOT_BOOKABLE'
  if (msg.includes('COVERAGE_REQUEST_NOT_BOOKABLE')) return 'COVERAGE_REQUEST_NOT_BOOKABLE'
  if (msg.includes('COVERAGE_INSUFFICIENT_OFFER')) return 'COVERAGE_INSUFFICIENT_OFFER'
  if (msg.includes('COVERAGE_INSUFFICIENT_REQUEST')) return 'COVERAGE_INSUFFICIENT_REQUEST'
  if (msg.includes('COVERAGE_NON_POSITIVE_AMOUNT')) return 'COVERAGE_NON_POSITIVE_AMOUNT'
  return 'COVERAGE_BOOKING_FAILED'
}

// ------------------------------------------------------------
// Exchange rate publish — also goes through a service-role RPC.
// ------------------------------------------------------------
export async function publishExchangeRateVersion(input: {
  accountId: string
  bookId: string
  versionId: string
  actorUserId: string | null
}): Promise<{ versionId: string }> {
  const { data, error } = await supabaseAdmin().rpc(
    'publish_exchange_rate_version',
    {
      p_book_id: input.bookId,
      p_version_id: input.versionId,
      p_actor_user_id: input.actorUserId,
    },
  )
  if (error) {
    const msg = (error as { message?: string }).message ?? 'Publish failed'
    const code = (error as { code?: string }).code
    if (code === 'P0001') {
      throw new ServiceError('EXCHANGE_PUBLISH_FAILED', msg, 409)
    }
    throw error
  }
  return { versionId: data as string }
}

// ------------------------------------------------------------
// Quote preview — pure compute over an already-loaded rule.
// ------------------------------------------------------------
export interface PreviewQuoteInput {
  accountId: string
  serviceId: string
  amount: string
  currency: string
  attributes?: Record<string, unknown>
}

export async function previewServiceQuote(
  input: PreviewQuoteInput,
): Promise<QuoteResult> {
  const db = supabaseAdmin()
  const { data: service, error: svcErr } = await db
    .from('services')
    .select(
      'id, status, current_revision_id, service_revisions!services_current_revision_fk(pricing_rule_id, service_pricing_rules(id, kind, fee_currency, input_currency, minimum_fee, maximum_fee, rounding_mode, formula_config))',
    )
    .eq('account_id', input.accountId)
    .eq('id', input.serviceId)
    .maybeSingle()
  if (svcErr) throw svcErr
  if (!service) {
    throw new ServiceError('SERVICE_NOT_FOUND', 'Service not found.', 404)
  }
  if ((service as { status: string }).status !== 'active') {
    throw new ServiceError(
      'SERVICE_NOT_ACTIVE',
      `Service is ${(service as { status: string }).status}.`,
      409,
    )
  }
  const rev = (service as { service_revisions: unknown }).service_revisions as
    | {
        pricing_rule_id: string | null
        service_pricing_rules: unknown
      }
    | Array<{
        pricing_rule_id: string | null
        service_pricing_rules: unknown
      }>
    | null
  const revision = Array.isArray(rev) ? rev[0] : rev
  if (!revision || !revision.service_pricing_rules) {
    throw new ServiceError(
      'NO_PRICING_RULE',
      'Service has no published pricing rule.',
      409,
    )
  }
  const ruleRow = Array.isArray(revision.service_pricing_rules)
    ? revision.service_pricing_rules[0]
    : revision.service_pricing_rules
  if (!ruleRow) {
    throw new ServiceError(
      'NO_PRICING_RULE',
      'Service has no published pricing rule.',
      409,
    )
  }
  const rule = {
    id: (ruleRow as { id: string }).id,
    kind: (ruleRow as { kind: QuoteResult['ruleKind'] }).kind as
      Parameters<typeof calculateQuote>[0]['kind'],
    feeCurrency:
      (ruleRow as { fee_currency: string | null }).fee_currency,
    inputCurrency:
      (ruleRow as { input_currency: string | null }).input_currency,
    minimumFee: (ruleRow as { minimum_fee: string | null }).minimum_fee,
    maximumFee: (ruleRow as { maximum_fee: string | null }).maximum_fee,
    roundingMode:
      (ruleRow as { rounding_mode: 'proportional' | 'ceil_started_unit' | 'floor_complete_unit' | 'nearest_unit' | null })
        .rounding_mode,
    formulaConfig:
      (ruleRow as { formula_config: Record<string, unknown> }).formula_config ?? {},
  }
  return calculateQuote(rule, {
    amount: input.amount,
    currency: input.currency,
    attributes: input.attributes,
  })
}

// ------------------------------------------------------------
// Live FX rate — reads the current published version of a book
// and returns the right side / pair / amount, OR
// `unavailable_stale` when the version is past its freshness
// window.
// ------------------------------------------------------------
export interface CurrentRateInput {
  accountId: string
  baseCurrency: string
  quoteCurrency: string
  intent: 'customer_sells_base' | 'customer_buys_base'
  region?: string | null
  channel?: string | null
  settlementMethod?: string | null
}

export type CurrentRateResult =
  | {
      status: 'current'
      book_version_id: string
      side: 'buy' | 'sell'
      rate: string
      published_at: string | null
      valid_until: string | null
      meaning: string
    }
  | {
      status: 'unavailable_stale'
      last_published_at: string | null
      customer_safe_message: string
    }
  | {
      status: 'not_found'
      customer_safe_message: string
    }

export async function getCurrentExchangeRate(
  input: CurrentRateInput,
): Promise<CurrentRateResult> {
  const db = supabaseAdmin()
  // Resolve the book by (region, channel, settlement) — fall back
  // to NULL region for the wildcard book if no exact match.
  let bookId: string | null = null
  for (const region of [input.region ?? null, null]) {
    let q = db
      .from('exchange_rate_books')
      .select('id, current_published_version_id, stale_after_seconds, region, channel, settlement_method')
      .eq('account_id', input.accountId)
      .eq('status', 'active')
    q = q.eq('region', region)
    q = q.eq('channel', input.channel ?? 'whatsapp')
    q = q.eq(
      'settlement_method',
      input.settlementMethod ?? null,
    )
    const { data, error } = await q.maybeSingle()
    if (error) throw error
    if (data) {
      bookId = (data as { id: string }).id
      break
    }
  }
  if (!bookId) {
    return {
      status: 'not_found',
      customer_safe_message:
        'No exchange rate is published for this context yet.',
    }
  }

  const { data: book, error: bookErr } = await db
    .from('exchange_rate_books')
    .select(
      'current_published_version_id, stale_after_seconds',
    )
    .eq('account_id', input.accountId)
    .eq('id', bookId)
    .maybeSingle()
  if (bookErr) throw bookErr
  if (!book || !(book as { current_published_version_id: string | null }).current_published_version_id) {
    return {
      status: 'not_found',
      customer_safe_message:
        'No exchange rate is published for this context yet.',
    }
  }
  const currentVersionId = (book as { current_published_version_id: string }).current_published_version_id
  const staleAfter = (book as { stale_after_seconds: number }).stale_after_seconds

  const { data: version, error: verErr } = await db
    .from('exchange_rate_book_versions')
    .select('effective_at, expires_at, published_at')
    .eq('account_id', input.accountId)
    .eq('id', currentVersionId)
    .maybeSingle()
  if (verErr) throw verErr
  if (!version) {
    return {
      status: 'not_found',
      customer_safe_message: 'Rate version missing.',
    }
  }

  const staleness = evaluateStaleness(
    {
      effective_at:
        (version as { effective_at: string | null }).effective_at,
      expires_at: (version as { expires_at: string | null }).expires_at,
      published_at:
        (version as { published_at: string | null }).published_at,
      stale_after_seconds: staleAfter,
    },
    new Date(),
  )
  if (staleness.isStale) {
    return {
      status: 'unavailable_stale',
      last_published_at:
        (version as { published_at: string | null }).published_at,
      customer_safe_message:
        'The current rate needs an update from the operations team.',
    }
  }

  const { data: rate, error: rateErr } = await db
    .from('exchange_rates')
    .select('buy_rate, sell_rate')
    .eq('account_id', input.accountId)
    .eq('version_id', currentVersionId)
    .eq('base_currency', input.baseCurrency)
    .eq('quote_currency', input.quoteCurrency)
    .maybeSingle()
  if (rateErr) throw rateErr
  if (!rate) {
    return {
      status: 'not_found',
      customer_safe_message: 'No rate published for this currency pair.',
    }
  }

  // Map the customer's intent to the buy/sell side.
  // intent='customer_sells_base' means the customer is selling
  // base currency to us → we BUY base → use buy_rate.
  const side = input.intent === 'customer_sells_base' ? 'buy' : 'sell'
  const value = side === 'buy'
    ? (rate as { buy_rate: string }).buy_rate
    : (rate as { sell_rate: string }).sell_rate
  const meaning =
    side === 'buy'
      ? `We buy ${input.baseCurrency} from the customer against ${input.quoteCurrency}.`
      : `We sell ${input.baseCurrency} to the customer for ${input.quoteCurrency}.`
  const validUntil = staleness.secondsUntilStale
    ? new Date(Date.now() + staleness.secondsUntilStale * 1000).toISOString()
    : (version as { expires_at: string | null }).expires_at
  return {
    status: 'current',
    book_version_id: currentVersionId,
    side,
    rate: value,
    published_at:
      (version as { published_at: string | null }).published_at,
    valid_until: validUntil,
    meaning,
  }
}
