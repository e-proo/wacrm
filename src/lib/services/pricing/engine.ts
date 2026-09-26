import { Decimal, formatDecimal, parseDecimal } from '@/lib/services/shared/money/decimal'
import type { MoneyJson } from '@/lib/services/shared/money/money-json'
import { DomainError } from '@/lib/services/platform/domain-error'

// ============================================================
// Pricing engine — pure functions over a service's published
// pricing rule.
//
// Phase 2 supports the kinds defined in plan §7.1:
//   fixed, percentage, per_unit, fixed_plus_percentage, tiered,
//   fx_buy_sell, manual_quote.
//
// Every function returns a structured QuoteResult (NOT just a
// number) so the caller / UI can render `rendered_facts` and the
// caller-side audit log gets every input + the rule version.
//
// Money precision: every arithmetic happens on Decimal. The
// `precision` field on the result is the OUTPUT scale the caller
// should serialize at; default 2 (most currencies).
// ============================================================

export interface QuoteInput extends MoneyJson {
  /** Raw amount string (e.g. "10000.00"). Decimal-parsed. */
  /** Service attributes that affect the calculation (e.g.
   *  coverage_region, deposit_method). Free-form; the rule body
   *  decides which keys it needs. */
  attributes?: Record<string, unknown>
}

export interface QuoteResult {
  status: 'quoted' | 'manual_quote_required'
  inputAmount: string
  inputCurrency: string
  feeAmount: string | null
  feeCurrency: string | null
  roundingMode: string | null
  precision: number
  ruleVersionId: string | null
  ruleKind: string
  /** Human-readable fact string the UI can render as-is. */
  renderedFacts: string
  /** Stable JSON for the audit log (inputs + rule body + output). */
  audit: Record<string, unknown>
}

export type RoundingMode =
  | 'proportional'
  | 'ceil_started_unit'
  | 'floor_complete_unit'
  | 'nearest_unit'

export interface PricingRuleShape {
  id: string
  kind: PricingKind
  feeCurrency: string | null
  inputCurrency: string | null
  minimumFee: string | null
  maximumFee: string | null
  roundingMode: RoundingMode | null
  formulaConfig: Record<string, unknown>
}

export type PricingKind =
  | 'fixed'
  | 'percentage'
  | 'per_unit'
  | 'fixed_plus_percentage'
  | 'tiered'
  | 'fx_buy_sell'
  | 'manual_quote'

/**
 * Compute a quote. The rule body is parsed by `kind`; the rest
 * of the rule (currency, min/max, rounding) is applied uniformly
 * at the end so the per-kind branches stay narrow.
 *
 * Returns a `QuoteResult` with `status: 'manual_quote_required'`
 * for `manual_quote` rules — no numeric output, just the prompt
 * for the operator.
 */
export function calculateQuote(
  rule: PricingRuleShape,
  input: QuoteInput,
): QuoteResult {
  const audit: Record<string, unknown> = {
    rule_kind: rule.kind,
    rule_id: rule.id,
    input,
  }

  // ----------------------------------------------------------------
  // Branch by rule kind. Each branch returns a fee Decimal (or
  // null for manual_quote) + a rendered-facts string.
  // ----------------------------------------------------------------
  let fee: Decimal | null = null
  let rendered = ''
  const roundingMode = rule.roundingMode

  switch (rule.kind) {
    case 'fixed': {
      const raw = rule.formulaConfig.amount
      fee = parseDecimal(typeof raw === 'string' ? raw : null)
      if (!fee) {
        throw new PricingError('INVALID_RULE', 'fixed rule is missing amount')
      }
      rendered = `Flat fee of ${fee.toFixed(2)} ${rule.feeCurrency ?? input.currency}.`
      break
    }

    case 'percentage': {
      const pct = parseDecimal(rule.formulaConfig.percentage as string)
      const base = parseDecimal(input.amount)
      if (!pct || !base) {
        throw new PricingError('INVALID_INPUT', 'percentage rule needs numeric percentage and amount')
      }
      fee = base.times(pct).dividedBy(100)
      rendered = `${pct.toFixed(2)}% of ${base.toFixed(2)} ${input.currency} = ${fee.toFixed(2)} ${rule.feeCurrency ?? input.currency}.`
      break
    }

    case 'per_unit': {
      // The canonical "6 per 1000" example from plan §7.3.
      const unitSize = parseDecimal(rule.formulaConfig.unit_size as string)
      const ratePerUnit = parseDecimal(rule.formulaConfig.rate_per_unit as string)
      const base = parseDecimal(input.amount)
      if (!unitSize || !ratePerUnit || !base || unitSize.lte(0)) {
        throw new PricingError(
          'INVALID_RULE',
          'per_unit rule needs unit_size, rate_per_unit, and a positive unit_size',
        )
      }
      // Round UNITS first using the rule's mode (if it targets
      // units), then multiply by rate. This is the "started
      // unit" semantics.
      const unitsExact = base.dividedBy(unitSize)
      let units = unitsExact
      const unitRounding = rule.formulaConfig.unit_rounding as RoundingMode | undefined
      switch (unitRounding) {
        case 'ceil_started_unit':
          units = unitsExact.ceil()
          break
        case 'floor_complete_unit':
          units = unitsExact.floor()
          break
        case 'nearest_unit':
          units = unitsExact.round()
          break
        case 'proportional':
        default:
          // proportional: keep fractional units.
          units = unitsExact
          break
      }
      fee = units.times(ratePerUnit)
      rendered = `${base.toFixed(2)} ${input.currency} at ${ratePerUnit.toFixed(2)} per ${unitSize.toFixed(0)} → ${units.toString()} units → ${fee.toFixed(2)} ${rule.feeCurrency ?? input.currency}.`
      break
    }

    case 'fixed_plus_percentage': {
      const fixed = parseDecimal(rule.formulaConfig.fixed as string)
      const pct = parseDecimal(rule.formulaConfig.percentage as string)
      const base = parseDecimal(input.amount)
      if (!fixed || !pct || !base) {
        throw new PricingError('INVALID_RULE', 'fixed_plus_percentage rule needs fixed, percentage, and amount')
      }
      fee = fixed.plus(base.times(pct).dividedBy(100))
      rendered = `${fixed.toFixed(2)} + ${pct.toFixed(2)}% of ${base.toFixed(2)} ${input.currency} = ${fee.toFixed(2)} ${rule.feeCurrency ?? input.currency}.`
      break
    }

    case 'tiered': {
      const base = parseDecimal(input.amount)
      const tiers = rule.formulaConfig.tiers as
        | Array<{ up_to: string; rate_per_unit: string; unit_size?: string }>
        | undefined
      if (!base || !Array.isArray(tiers) || tiers.length === 0) {
        throw new PricingError('INVALID_RULE', 'tiered rule needs tiers[] with up_to + rate_per_unit')
      }
      // Walk tiers, applying each up to its ceiling.
      let remaining = base
      let accumulated = new Decimal(0)
      for (const tier of tiers) {
        if (remaining.lte(0)) break
        const ceiling = tier.up_to === '*' ? null : parseDecimal(tier.up_to)
        const unitSize = parseDecimal(tier.unit_size ?? '1') ?? new Decimal(1)
        const rate = parseDecimal(tier.rate_per_unit)
        if (!rate) {
          throw new PricingError('INVALID_RULE', 'tier entry missing rate_per_unit')
        }
        const chunk =
          ceiling === null ? remaining : Decimal.min(remaining, ceiling)
        accumulated = accumulated.plus(chunk.times(rate).dividedBy(unitSize))
        remaining = remaining.minus(chunk)
      }
      fee = accumulated
      rendered = `Tiered fee across ${tiers.length} bracket(s) for ${base.toFixed(2)} ${input.currency} = ${fee.toFixed(2)} ${rule.feeCurrency ?? input.currency}.`
      break
    }

    case 'fx_buy_sell': {
      // Fee = base_amount * sell_rate (the customer's perspective
      // when paying in the quote currency for the base currency).
      const base = parseDecimal(input.amount)
      const side = rule.formulaConfig.side as 'buy' | 'sell' | undefined
      const buyRate = parseDecimal(rule.formulaConfig.buy_rate as string)
      const sellRate = parseDecimal(rule.formulaConfig.sell_rate as string)
      if (!base || !buyRate || !sellRate || (side !== 'buy' && side !== 'sell')) {
        throw new PricingError(
          'INVALID_RULE',
          'fx_buy_sell rule needs amount, buy_rate, sell_rate, and side ("buy"|"sell")',
        )
      }
      const rate = side === 'buy' ? buyRate : sellRate
      fee = base.times(rate)
      rendered = `${side === 'buy' ? 'Buy' : 'Sell'} ${base.toFixed(2)} ${input.currency} @ ${rate.toFixed(4)} = ${fee.toFixed(2)} ${rule.feeCurrency ?? input.currency}.`
      break
    }

    case 'manual_quote': {
      return {
        status: 'manual_quote_required',
        inputAmount: input.amount,
        inputCurrency: input.currency,
        feeAmount: null,
        feeCurrency: rule.feeCurrency,
        roundingMode: null,
        precision: 2,
        ruleVersionId: rule.id,
        ruleKind: rule.kind,
        renderedFacts:
          'A human operator must quote this request; no automatic fee.',
        audit,
      }
    }

    default: {
      const exhaustive: never = rule.kind
      throw new PricingError(
        'UNKNOWN_RULE_KIND',
        `Unknown pricing rule kind: ${String(exhaustive)}`,
      )
    }
  }

  // ----------------------------------------------------------------
  // Shared finalization: clamp to min/max, apply rounding, format.
  // ----------------------------------------------------------------
  if (fee) {
    if (rule.minimumFee) {
      const min = parseDecimal(rule.minimumFee)
      if (min && fee.lt(min)) fee = min
    }
    if (rule.maximumFee) {
      const max = parseDecimal(rule.maximumFee)
      if (max && fee.gt(max)) fee = max
    }
    if (roundingMode === 'nearest_unit') {
      fee = fee.round()
    }
  }

  const precision = 2
  const feeAmount = fee ? formatDecimal(fee, precision) : null
  const feeCurrency = rule.feeCurrency ?? input.currency

  return {
    status: 'quoted',
    inputAmount: input.amount,
    inputCurrency: input.currency,
    feeAmount,
    feeCurrency,
    roundingMode,
    precision,
    ruleVersionId: rule.id,
    ruleKind: rule.kind,
    renderedFacts: rendered,
    audit: { ...audit, fee_amount: feeAmount, fee_currency: feeCurrency },
  }
}

export class PricingError extends DomainError {
  constructor(code: string, message: string, status = 400) {
    super(code, message, status)
    this.name = 'PricingError'
  }
}
