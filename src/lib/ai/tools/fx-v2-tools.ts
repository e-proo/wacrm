import { createChangeRequest } from '@/lib/ai/runtime/change-requests-service'
import {
  createFxTradeRequest,
  FxServiceError,
  getCurrentFxRate,
  getFxBaseCurrency,
} from '@/lib/services/fx-v2/service'
import { effectiveRateForSide, type FxTradeSide } from '@/lib/services/fx-v2/engine'
import type { ToolContext, ToolResult } from './executors'

const CURRENCY_CODE = /^[A-Z_]{3,8}$/

type LegacyFxIntent = 'customer_sells_base' | 'customer_buys_base'

export interface FxV2GetCurrentArgs {
  base_currency: string
  quote_currency?: string | null
  intent: LegacyFxIntent
  /** Legacy context only. FX V2 does not price by region. */
  region?: string | null
  /** Legacy context only. FX V2 does not price by settlement method. */
  settlement?: 'cash' | 'bank' | 'wallet' | 'other' | null
}

export interface FxV2RecordTradeRequestArgs extends FxV2GetCurrentArgs {
  base_amount: string
  /** Exact immutable rate version returned by exchange_rates.get_current. */
  expected_rate_version_id: string
}

function normalizeCurrency(value: unknown): string | null {
  const code = String(value ?? '').trim().toUpperCase()
  return CURRENCY_CODE.test(code) ? code : null
}

export function fxTradeSideFromIntent(intent: LegacyFxIntent): FxTradeSide {
  if (intent === 'customer_buys_base') return 'customer_buy'
  if (intent === 'customer_sells_base') return 'customer_sell'
  throw new FxServiceError('FX_INVALID_TRADE_SIDE', 'Unsupported customer FX intent.')
}

function validateIntent(intent: unknown): intent is LegacyFxIntent {
  return intent === 'customer_sells_base' || intent === 'customer_buys_base'
}

async function resolvePairCodes(
  ctx: ToolContext,
  baseInput: unknown,
  quoteInput: unknown,
): Promise<
  | { ok: true; base: string; quote: string; quoteDefaulted: boolean }
  | { ok: false; result: ToolResult<never> }
> {
  const base = normalizeCurrency(baseInput)
  if (!base) {
    return {
      ok: false,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'INVALID_CURRENCY_PAIR',
        message: 'A valid base currency code is required.',
      },
    }
  }

  const explicitQuote = String(quoteInput ?? '').trim()
  let quote = explicitQuote ? normalizeCurrency(explicitQuote) : null
  let quoteDefaulted = false

  if (explicitQuote && !quote) {
    return {
      ok: false,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'INVALID_CURRENCY_PAIR',
        message: 'quote_currency must be a configured currency code.',
      },
    }
  }

  if (!quote) {
    const configuredCounter = await getFxBaseCurrency(ctx.accountId)
    if (!configuredCounter || configuredCounter.status !== 'active') {
      return {
        ok: false,
        result: {
          ok: false,
          data: null,
          safe_to_show: true,
          code: 'FX_COUNTER_CURRENCY_NOT_CONFIGURED',
          message: 'No default FX counter currency is configured for this account.',
        },
      }
    }
    quote = configuredCounter.code
    quoteDefaulted = true
  }

  if (base === quote) {
    return {
      ok: false,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'INVALID_CURRENCY_PAIR',
        message: 'Base and quote currencies must be different.',
      },
    }
  }

  return { ok: true, base, quote, quoteDefaulted }
}

function safeFxFailure(err: unknown, fallbackCode: string, fallbackMessage: string): ToolResult<never> {
  if (err instanceof FxServiceError) {
    const safeCodes = new Set([
      'FX_INVALID_CURRENCY_CODE',
      'FX_INVALID_TRADE_SIDE',
      'FX_INVALID_TRADE_AMOUNT',
      'FX_INVALID_IDEMPOTENCY_KEY',
      'FX_PAIR_NOT_FOUND',
      'FX_PAIR_NOT_ACTIVE',
      'FX_PAIR_CURRENCY_DISABLED',
      'FX_RATE_NOT_PUBLISHED',
      'FX_RATE_VERSION_CONFLICT',
      'FX_RATE_VERSION_NOT_FOUND',
      'FX_AMOUNT_ROUNDS_TO_ZERO',
      'FX_IDEMPOTENCY_KEY_REUSED',
    ])
    return {
      ok: false,
      data: null,
      safe_to_show: safeCodes.has(err.code),
      code: err.code,
      message: safeCodes.has(err.code) ? err.message : fallbackMessage,
    }
  }
  console.error(`[tool] ${fallbackCode}:`, err)
  return {
    ok: false,
    data: null,
    safe_to_show: false,
    code: fallbackCode,
    message: fallbackMessage,
  }
}

/**
 * Customer/admin live-rate reader backed only by FX V2.
 * Region/settlement inputs are accepted for backward compatibility but never
 * participate in price selection; V2 pair + immutable current version are the
 * sole financial source of truth.
 */
export async function executeFxV2GetCurrent(
  ctx: ToolContext,
  args: FxV2GetCurrentArgs,
): Promise<ToolResult<unknown>> {
  if (!validateIntent(args.intent)) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INTENT',
      message: 'intent must be customer_sells_base or customer_buys_base.',
    }
  }

  try {
    const resolved = await resolvePairCodes(ctx, args.base_currency, args.quote_currency)
    if (!resolved.ok) return resolved.result

    const current = await getCurrentFxRate(ctx.accountId, resolved.base, resolved.quote)
    if (!current) {
      return {
        ok: true,
        data: {
          status: 'not_found',
          base_currency: resolved.base,
          quote_currency: resolved.quote,
          quote_currency_defaulted: resolved.quoteDefaulted,
        },
        safe_to_show: true,
      }
    }

    const side = fxTradeSideFromIntent(args.intent)
    const effective = effectiveRateForSide(
      side,
      current.businessBuyRate,
      current.businessSellRate,
    )

    return {
      ok: true,
      data: {
        status: 'current',
        pair_id: current.pair.id,
        base_currency: current.pair.base.code,
        quote_currency: current.pair.quote.code,
        quote_currency_defaulted: resolved.quoteDefaulted,
        customer_side: args.intent,
        effective_rate: effective.rate.toFixed(8),
        rate_version_id: current.rateVersionId,
        version_number: current.versionNumber,
        published_at: current.publishedAt,
        meaning:
          side === 'customer_buy'
            ? `Customer buys ${current.pair.base.code}; business sell rate applies.`
            : `Customer sells ${current.pair.base.code}; business buy rate applies.`,
      },
      safe_to_show: true,
    }
  } catch (err) {
    return safeFxFailure(err, 'FX_RATE_READ_FAILED', 'Could not read the current exchange rate.')
  }
}

function customerBinding(ctx: ToolContext):
  | { ok: true; contactId: string; conversationId: string; sourceMessageId: string }
  | { ok: false; result: ToolResult<never> } {
  if (ctx.plane !== 'customer') {
    return {
      ok: false,
      result: {
        ok: false,
        data: null,
        safe_to_show: false,
        code: 'CUSTOMER_CONTEXT_REQUIRED',
        message: 'This operation must originate from a customer conversation.',
      },
    }
  }
  if (!ctx.contactId || !ctx.conversationId || !ctx.sourceMessageId) {
    return {
      ok: false,
      result: {
        ok: false,
        data: null,
        safe_to_show: false,
        code: 'CUSTOMER_CONTEXT_MISSING',
        message: 'The runtime did not bind the request to its source message.',
      },
    }
  }
  return {
    ok: true,
    contactId: ctx.contactId,
    conversationId: ctx.conversationId,
    sourceMessageId: ctx.sourceMessageId,
  }
}

/**
 * Creates the authoritative FX V2 trade request directly. The immutable rate
 * snapshot remains the financial source of truth, while a standard change
 * request supplies the same trusted-admin notification/approval gate used by
 * coverage handoffs. The trade is never recreated by the approval executor;
 * approval only moves the existing pending_admin request forward.
 */
export async function executeFxV2RecordTradeRequest(
  ctx: ToolContext,
  args: FxV2RecordTradeRequestArgs,
): Promise<ToolResult<unknown>> {
  const bound = customerBinding(ctx)
  if (!bound.ok) return bound.result

  if (!validateIntent(args.intent)) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INTENT',
      message: 'intent must be customer_sells_base or customer_buys_base.',
    }
  }

  const amount = String(args.base_amount ?? '').trim()
  if (!amount) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_AMOUNT',
      message: 'base_amount is required.',
    }
  }

  const expectedRateVersionId = String(args.expected_rate_version_id ?? '').trim()
  if (!expectedRateVersionId) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'FX_QUOTED_RATE_VERSION_REQUIRED',
      message: 'Read the current exchange rate and use its rate_version_id before submitting the trade request.',
    }
  }

  try {
    const resolved = await resolvePairCodes(ctx, args.base_currency, args.quote_currency)
    if (!resolved.ok) return resolved.result

    const current = await getCurrentFxRate(ctx.accountId, resolved.base, resolved.quote)
    if (!current) {
      return {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'FX_RATE_NOT_PUBLISHED',
        message: 'No current FX rate is published for this pair.',
      }
    }

    if (expectedRateVersionId !== current.rateVersionId) {
      return {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'FX_RATE_VERSION_CONFLICT',
        message: 'The quoted exchange rate changed. Read the current rate again before submitting the request.',
      }
    }

    const side = fxTradeSideFromIntent(args.intent)
    const idempotencyKey = [
      'fx-v2-tool',
      bound.sourceMessageId,
      current.pair.id,
      side,
      amount,
      expectedRateVersionId,
    ].join(':')

    const trade = await createFxTradeRequest({
      accountId: ctx.accountId,
      pairId: current.pair.id,
      side,
      amountBasis: 'base',
      requestedAmount: amount,
      idempotencyKey,
      expectedRateVersionId,
      contactId: bound.contactId,
      conversationId: bound.conversationId,
      metadata: {
        source: 'ai_runtime',
        tool: 'exchange_rates.record_trade_request',
        source_message_id: bound.sourceMessageId,
        quoted_rate_version_id: expectedRateVersionId,
        ...(ctx.runId ? { run_id: ctx.runId } : {}),
        ...(ctx.agentId ? { agent_id: ctx.agentId } : {}),
        ...(ctx.revisionId ? { revision_id: ctx.revisionId } : {}),
        ...((args.region ?? args.settlement)
          ? {
              legacy_context: {
                region: args.region ?? null,
                settlement: args.settlement ?? null,
              },
            }
          : {}),
      },
    })

    let review: { status: string } | null = null
    if (trade.status === 'pending_admin') {
      const actionAr = args.intent === 'customer_sells_base' ? 'بيع' : 'شراء'
      const change = await createChangeRequest({
        accountId: ctx.accountId,
        targetType: 'fx_trade_request',
        targetId: trade.requestId,
        intent: 'update',
        proposedPayload: {
          expected_status: 'pending_admin',
          decision: 'approve',
          note: null,
          rate_version_id: trade.rateVersionId,
          contact_id: bound.contactId,
          conversation_id: bound.conversationId,
          requested_amount: trade.baseAmount,
          currency: current.pair.base.code,
          base_currency: current.pair.base.code,
          quote_currency: current.pair.quote.code,
          customer_side: args.intent,
          effective_rate: trade.effectiveRate,
          base_amount: trade.baseAmount,
          quote_amount: trade.quoteAmount,
          trade_code: trade.code,
        },
        idempotencyKey: `fx-trade-review:${trade.requestId}:pending_admin`,
        summary: `طلب ${actionAr} عملة FX-${trade.code}: ${trade.baseAmount} ${current.pair.base.code} مقابل ${trade.quoteAmount} ${current.pair.quote.code} بسعر ${trade.effectiveRate}`,
        actorUserId: ctx.actorUserId,
      })
      review = { status: change.status }
      console.info(
        `[tool] FX V2 trade ${trade.requestId} pending admin via CHG-${change.code}`,
      )
    }

    return {
      ok: true,
      data: {
        trade_request: {
          request_id: trade.requestId,
          code: trade.code,
          status: trade.status,
          pair_id: current.pair.id,
          base_currency: current.pair.base.code,
          quote_currency: current.pair.quote.code,
          customer_side: args.intent,
          rate_version_id: trade.rateVersionId,
          effective_rate: trade.effectiveRate,
          base_amount: trade.baseAmount,
          quote_amount: trade.quoteAmount,
          idempotent: trade.idempotent,
        },
        ...(review
          ? {
              admin_review: {
                status: review.status,
                forwarded_to_admin: true,
              },
            }
          : {}),
      },
      safe_to_show: true,
    }
  } catch (err) {
    return safeFxFailure(
      err,
      'FX_TRADE_REQUEST_FAILED',
      'Could not create the currency trade request.',
    )
  }
}
