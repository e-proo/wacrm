// Server-only by convention — see repositories.ts comment.
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { parseDecimal } from '@/lib/services/pricing/decimal'
import { calculateQuote, type QuoteResult } from '@/lib/services/pricing/engine'
import { DomainError } from '@/lib/services/platform/domain-error'
import { normalizeIdempotencyKey } from '@/lib/services/platform/idempotency'

// ============================================================
// Services, coverage, and pricing domain services.
//
// FX authority lives exclusively in src/lib/services/fx-v2/.
// This shared layer intentionally contains no legacy rate-book reads/writes.
// ============================================================

export class ServiceError extends DomainError {
  constructor(code: string, message: string, status = 400) {
    super(code, message, status)
    this.name = 'ServiceError'
  }
}

export interface PublishPricingRuleInput {
  accountId: string
  ruleId: string
  actorUserId: string | null
}

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
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey)
  if (!idempotencyKey) {
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
    p_idempotency_key: idempotencyKey,
    p_reserved_until: input.reservedUntil ?? null,
    p_rate_snapshot: input.rateSnapshot ?? {},
    p_fee_snapshot: input.feeSnapshot ?? {},
    p_provider_cost: input.providerCost ? parseDecimal(input.providerCost)?.toString() ?? null : null,
    p_customer_fee: input.customerFee ? parseDecimal(input.customerFee)?.toString() ?? null : null,
    p_actor_user_id: input.actorUserId,
  })
  if (error) {
    const code = (error as { code?: string }).code
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
