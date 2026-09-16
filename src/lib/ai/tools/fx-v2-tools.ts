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
  /**
   * Rate version shown to the customer by exchange_rates.get_current.
   * When supplied, submission is rejected if that quote is no longer current.
   */
  expected_rate_version_id?: string | null
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
 * Creates the authoritative FX V2 trade request directly. No customer_intent
 * and no rate-book change request is created. The exact immutable rate version
 * and calculated amounts are snapshotted by the Phase 2 RPC.
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

    if (
      args.expected_rate_version_id &&
      args.expected_rate_version_id !== current.rateVersionId
    ) {
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
    ].join(':')

    const trade = await createFxTradeRequest({
      accountId: ctx.accountId,
      pairId: current.pair.id,
      side,
      amountBasis: 'base',
      requestedAmount: amount,
      idempotencyKey,
      expectedRateVersionId: args.expected_rate_version_id ?? current.rateVersionId,
      contactId: bound.contactId,
      conversationId: bound.conversationId,
      metadata: {
        source: 'ai_runtime',
        tool: 'exchange_rates.record_trade_request',
        source_message_id: bound.sourceMessageId,
        ...(ctx.runId ? { run_id: ctx.runId } : {}),
        ...(ctx.agentId ? { agent_id: ctx.agentId } : {}),
        ...(ctx.revisionId ? { revision_id: ctx.revisionId } : {}),
        ...(args.expected_rate_version_id
          ? { quoted_rate_version_id: args.expected_rate_version_id }
          : {}),
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
