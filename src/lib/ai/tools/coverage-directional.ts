import Decimal from 'decimal.js'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import {
  executeCoverageFindOffers,
  executeCoverageGetRates,
  type ToolContext,
  type ToolResult,
} from './executors'
import {
  executeCoverageProposeOfferIntegrated,
  executeCoverageProposeRequest,
} from './business-handoff'
import {
  classifyCoverageDirection,
  type CoverageMacroRegion,
} from '@/lib/services/coverage/direction'
import {
  normalizeCoverageAttributes,
  readCoverageAttributes,
  type CoverageMethod,
} from '@/lib/services/coverage/attributes'

interface RegionRow {
  id: string
  code: string
  name: string
  macro_region: CoverageMacroRegion
}

interface ResolvedLeg {
  region_id: string | null
  region_code: string | null
  region_name: string | null
  macro: CoverageMacroRegion | null
  method: CoverageMethod
}

export interface DirectionalCoverageRateArgs {
  scope?: 'north' | 'south' | 'international' | 'all'
  amount?: string
  currency?: string
  pay_region_id?: string
  pay_region?: string
  pay_macro?: CoverageMacroRegion
  pay_method?: CoverageMethod
  receive_region_id?: string
  receive_region?: string
  receive_macro?: CoverageMacroRegion
  receive_method?: CoverageMethod
}

export interface DirectionalCoverageFindArgs {
  service_id: string
  currency: string
  min_available?: string
  pay_region_id?: string
  pay_region?: string
  pay_macro?: CoverageMacroRegion
  pay_method?: CoverageMethod
  receive_region_id?: string
  receive_region?: string
  receive_macro?: CoverageMacroRegion
  receive_method?: CoverageMethod
  limit?: number
}

type ProposalKind = 'offer' | 'request'

type DirectionalProposalArgs = {
  service_id?: string
  total_amount?: string
  requested_amount?: string
  currency?: string
  attributes?: Record<string, unknown>
  commission_per_thousand?: string
  commission_currency?: string
  deal_date?: string
  expires_at?: string
}

function normalizeRegionText(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
}

async function loadRegions(ctx: ToolContext): Promise<RegionRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('coverage_regions')
    .select('id, code, name, macro_region')
    .eq('account_id', ctx.accountId)
    .eq('status', 'active')
  if (error) throw error
  return (data ?? []) as RegionRow[]
}

function resolveRegion(
  regions: RegionRow[],
  input: { id?: string; text?: string; macro?: CoverageMacroRegion },
): { ok: true; region: RegionRow | null; macro: CoverageMacroRegion | null } | { ok: false; message: string } {
  let region: RegionRow | null = null

  if (input.id) {
    region = regions.find((r) => r.id === input.id) ?? null
    if (!region) return { ok: false, message: `Unknown coverage region id: ${input.id}` }
  } else if (input.text?.trim()) {
    const needle = normalizeRegionText(input.text)
    const exact = regions.filter(
      (r) =>
        normalizeRegionText(r.code) === needle ||
        normalizeRegionText(r.name) === needle,
    )
    if (exact.length === 1) region = exact[0]
    else if (exact.length > 1) {
      return { ok: false, message: `Ambiguous coverage region: ${input.text}` }
    } else {
      const partial = regions.filter((r) => {
        const code = normalizeRegionText(r.code)
        const name = normalizeRegionText(r.name)
        return code.includes(needle) || name.includes(needle) || needle.includes(code) || needle.includes(name)
      })
      if (partial.length === 1) region = partial[0]
      else if (partial.length > 1) {
        return { ok: false, message: `Ambiguous coverage region: ${input.text}` }
      } else {
        return { ok: false, message: `Coverage region not found: ${input.text}` }
      }
    }
  }

  if (region && input.macro && region.macro_region !== input.macro) {
    return {
      ok: false,
      message: `Region ${region.name} belongs to ${region.macro_region}, not ${input.macro}.`,
    }
  }

  return { ok: true, region, macro: region?.macro_region ?? input.macro ?? null }
}

async function resolveLegs(
  ctx: ToolContext,
  args: {
    pay_region_id?: string
    pay_region?: string
    pay_macro?: CoverageMacroRegion
    pay_method?: CoverageMethod
    receive_region_id?: string
    receive_region?: string
    receive_macro?: CoverageMacroRegion
    receive_method?: CoverageMethod
  },
): Promise<
  | { ok: true; pay: ResolvedLeg; receive: ResolvedLeg; regions: RegionRow[] }
  | { ok: false; result: ToolResult<never> }
> {
  try {
    const regions = await loadRegions(ctx)
    const payResolved = resolveRegion(regions, {
      id: args.pay_region_id,
      text: args.pay_region,
      macro: args.pay_macro,
    })
    if (!payResolved.ok) {
      return {
        ok: false,
        result: {
          ok: false,
          data: null,
          safe_to_show: true,
          code: 'PAY_REGION_NOT_RESOLVED',
          message: payResolved.message,
        },
      }
    }
    const receiveResolved = resolveRegion(regions, {
      id: args.receive_region_id,
      text: args.receive_region,
      macro: args.receive_macro,
    })
    if (!receiveResolved.ok) {
      return {
        ok: false,
        result: {
          ok: false,
          data: null,
          safe_to_show: true,
          code: 'RECEIVE_REGION_NOT_RESOLVED',
          message: receiveResolved.message,
        },
      }
    }

    return {
      ok: true,
      regions,
      pay: {
        region_id: payResolved.region?.id ?? null,
        region_code: payResolved.region?.code ?? null,
        region_name: payResolved.region?.name ?? args.pay_region ?? null,
        macro: payResolved.macro,
        method: args.pay_method ?? 'any',
      },
      receive: {
        region_id: receiveResolved.region?.id ?? null,
        region_code: receiveResolved.region?.code ?? null,
        region_name: receiveResolved.region?.name ?? args.receive_region ?? null,
        macro: receiveResolved.macro,
        method: args.receive_method ?? 'any',
      },
    }
  } catch (err) {
    console.error('[tool] coverage region resolution failed:', err)
    return {
      ok: false,
      result: {
        ok: false,
        data: null,
        safe_to_show: false,
        code: 'COVERAGE_REGION_READ_FAILED',
        message: 'Could not resolve coverage regions.',
      },
    }
  }
}

function directionRules() {
  return [
    {
      pay_macro: 'south',
      receive_macro: 'north',
      case_type: 'offer',
      commission_effect: 'customer_receives',
      customer_term_ar: 'راجع للعميل',
      rate_market: 'north',
    },
    {
      pay_macro: 'north',
      receive_macro: 'south',
      case_type: 'request',
      commission_effect: 'customer_pays',
      customer_term_ar: 'عمولة',
      rate_market: 'south',
    },
  ]
}

function hasDirectionalInput(args: DirectionalCoverageRateArgs): boolean {
  return Boolean(
    args.pay_region_id ||
      args.pay_region ||
      args.pay_macro ||
      args.receive_region_id ||
      args.receive_region ||
      args.receive_macro,
  )
}

function extractCoverageRate(
  data: unknown,
  market: 'north' | 'south',
): string | null {
  if (!data || typeof data !== 'object') return null
  const markets = (data as { markets?: Record<string, unknown> }).markets
  const row = markets?.[market]
  if (!row || typeof row !== 'object') return null
  const value = (row as { coverage_per_1000?: unknown }).coverage_per_1000
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  return null
}

function calculateCommission(amount: string, rate: string): string {
  return new Decimal(amount).times(rate).dividedBy(1000).toFixed()
}

export async function executeCoverageGetRatesDirectional(
  ctx: ToolContext,
  args: DirectionalCoverageRateArgs,
): Promise<ToolResult<unknown>> {
  const base = await executeCoverageGetRates(
    ctx,
    { scope: hasDirectionalInput(args) ? 'all' : args.scope } as never,
  )
  if (!base.ok) return base

  const baseData =
    base.data && typeof base.data === 'object'
      ? (base.data as Record<string, unknown>)
      : { published: false }

  if (!hasDirectionalInput(args)) {
    return {
      ...base,
      data: {
        ...baseData,
        domestic_direction_rules: directionRules(),
        commission_formula: 'commission_amount = amount * rate_per_1000 / 1000',
        terminology_note_ar:
          'راجع للعميل وعمولة ليستا خدمتين مختلفتين؛ اتجاه الدفع والاستلام هو الذي يحدد من يدفع العمولة ومن يستلمها.',
      },
    }
  }

  if (args.amount !== undefined) {
    try {
      const amount = new Decimal(args.amount)
      if (!amount.isFinite() || amount.lte(0)) throw new Error('invalid')
    } catch {
      return {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'INVALID_AMOUNT',
        message: 'amount must be a positive decimal string.',
      }
    }
    if (!args.currency?.trim()) {
      return {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'CURRENCY_REQUIRED',
        message: 'currency is required when amount is supplied.',
      }
    }
  }

  const resolved = await resolveLegs(ctx, args)
  if (!resolved.ok) return resolved.result
  const direction = classifyCoverageDirection(resolved.pay.macro, resolved.receive.macro)
  if (!direction.supported || !direction.kind || !direction.rateMarket) {
    return {
      ok: false,
      data: {
        published: Boolean(baseData.published),
        resolved_legs: { pay: resolved.pay, receive: resolved.receive },
        direction,
        domestic_direction_rules: directionRules(),
      },
      safe_to_show: true,
      code: direction.code,
      message: direction.explanationAr,
    }
  }

  const rate = extractCoverageRate(baseData, direction.rateMarket)
  const published = baseData.published === true
  const quoteStatus = !published || rate === null
    ? 'rate_unpublished'
    : args.amount
      ? 'quoted'
      : 'rate_only'
  const commissionAmount =
    rate !== null && args.amount ? calculateCommission(args.amount, rate) : null

  const result = {
    ...baseData,
    resolved_legs: { pay: resolved.pay, receive: resolved.receive },
    direction: {
      case_type: direction.kind,
      code: direction.code,
      commission_effect: direction.commissionEffect,
      customer_term_ar: direction.customerTermAr,
      rate_market: direction.rateMarket,
      explanation_ar: direction.explanationAr,
    },
    quote: {
      status: quoteStatus,
      amount: args.amount ?? null,
      currency: args.currency ?? null,
      rate_per_1000: rate,
      commission_amount: commissionAmount,
      commission_currency: args.currency ?? null,
      effect: direction.commissionEffect,
      customer_term_ar: direction.customerTermAr,
      formula: 'amount * rate_per_1000 / 1000',
    },
    domestic_direction_rules: directionRules(),
    terminology_note_ar:
      'راجع للعميل وعمولة هما نفس مفهوم العمولة؛ الفرق الاقتصادي يحدده اتجاه العميل: جنوب→شمال يرجع للعميل، شمال→جنوب يدفعه العميل.',
  }

  console.info(
    `[tool] coverage.get_rates direction=${direction.code} published=${published} quote=${quoteStatus}`,
  )
  return { ok: true, data: result, safe_to_show: true }
}

function methodMatches(actual: CoverageMethod, wanted: CoverageMethod): boolean {
  return actual === 'any' || wanted === 'any' || actual === wanted
}

function regionMatches(
  regionId: string | null,
  wanted: ResolvedLeg,
  byId: Map<string, RegionRow>,
): boolean {
  if (wanted.region_id) return regionId === wanted.region_id
  if (!wanted.macro) return true
  if (!regionId) return false
  return byId.get(regionId)?.macro_region === wanted.macro
}

export async function executeCoverageFindOffersDirectional(
  ctx: ToolContext,
  args: DirectionalCoverageFindArgs,
): Promise<ToolResult<unknown>> {
  const hasBothLegs = Boolean(
    (args.pay_region_id || args.pay_region || args.pay_macro) &&
      (args.receive_region_id || args.receive_region || args.receive_macro),
  )
  if (!hasBothLegs) {
    // Backward compatibility for old published revisions/call patterns.
    return executeCoverageFindOffers(ctx, args as never)
  }

  const resolved = await resolveLegs(ctx, args)
  if (!resolved.ok) return resolved.result
  const direction = classifyCoverageDirection(resolved.pay.macro, resolved.receive.macro)
  if (!direction.supported || !direction.kind) {
    return {
      ok: false,
      data: { resolved_legs: { pay: resolved.pay, receive: resolved.receive }, direction },
      safe_to_show: true,
      code: direction.code,
      message: direction.explanationAr,
    }
  }

  if (direction.kind === 'offer') {
    return {
      ok: true,
      data: {
        case_type: 'offer',
        search_applicable: false,
        resolved_legs: { pay: resolved.pay, receive: resolved.receive },
        direction: {
          code: direction.code,
          commission_effect: direction.commissionEffect,
          customer_term_ar: direction.customerTermAr,
        },
        next_action: 'quote the published north coverage rate, then use coverage.propose_offer after customer confirmation',
      },
      safe_to_show: true,
    }
  }

  // Canonical request is NORTH(pay) -> SOUTH(receive). Matching offers are
  // the anti-parallel side: offer.receive = request.pay and
  // offer.pay = request.receive.
  const raw = await executeCoverageFindOffers(
    { ...ctx, plane: 'admin' },
    {
      service_id: args.service_id,
      currency: args.currency,
      min_available: args.min_available,
      receive_region_id: resolved.pay.region_id ?? undefined,
      receive_macro: resolved.pay.region_id ? undefined : resolved.pay.macro ?? undefined,
      receive_method: resolved.pay.method,
      limit: args.limit,
    } as never,
  )
  if (!raw.ok) return raw

  const rows = Array.isArray(raw.data)
    ? (raw.data as Array<{
        offer_id: string
        reference_code: string
        available_amount: string
        currency: string
        commission_per_thousand: string | null
        commission_currency: string | null
        attributes: Record<string, unknown>
      }>)
    : []
  const byId = new Map(resolved.regions.map((r) => [r.id, r]))
  const filtered = rows.filter((row) => {
    const attrs = readCoverageAttributes(row.attributes)
    return (
      regionMatches(attrs.pay_region_id, resolved.receive, byId) &&
      methodMatches(attrs.pay_method, resolved.receive.method)
    )
  })

  if (ctx.plane === 'admin') {
    return { ok: true, data: filtered, safe_to_show: false }
  }

  const totalAvailable = filtered.reduce(
    (sum, row) => sum.plus(row.available_amount),
    new Decimal(0),
  )
  const options = new Map<
    string,
    {
      rate_per_1000: string | null
      commission_currency: string
      total_available: Decimal
      offer_count: number
    }
  >()
  for (const row of filtered) {
    const currency = row.commission_currency ?? row.currency
    const key = `${row.commission_per_thousand ?? 'null'}|${currency}`
    const existing = options.get(key) ?? {
      rate_per_1000: row.commission_per_thousand,
      commission_currency: currency,
      total_available: new Decimal(0),
      offer_count: 0,
    }
    existing.total_available = existing.total_available.plus(row.available_amount)
    existing.offer_count += 1
    options.set(key, existing)
  }

  const commissionOptions = [...options.values()].map((option) => ({
    rate_per_1000: option.rate_per_1000,
    commission_currency: option.commission_currency,
    total_available: option.total_available.toFixed(),
    offer_count: option.offer_count,
    commission_amount_for_requested_amount:
      option.rate_per_1000 !== null && args.min_available
        ? calculateCommission(args.min_available, option.rate_per_1000)
        : null,
  }))

  console.info(
    `[tool] coverage.find_offers canonical=request matches=${filtered.length} rate_options=${commissionOptions.length}`,
  )
  return {
    ok: true,
    data: {
      case_type: 'request',
      search_applicable: true,
      available: filtered.length > 0,
      total_available: totalAvailable.toFixed(),
      currency: args.currency,
      matching_offer_count: filtered.length,
      resolved_legs: { pay: resolved.pay, receive: resolved.receive },
      direction: {
        code: direction.code,
        commission_effect: direction.commissionEffect,
        customer_term_ar: direction.customerTermAr,
      },
      commission_options: commissionOptions,
    },
    safe_to_show: true,
  }
}

function proposalAmount(args: DirectionalProposalArgs): string | null {
  return args.total_amount ?? args.requested_amount ?? null
}

export async function executeCoverageDirectionalProposal(
  ctx: ToolContext,
  args: DirectionalProposalArgs,
  invokedAs: ProposalKind,
): Promise<ToolResult<unknown>> {
  if (!args.service_id || !args.currency || !proposalAmount(args)) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message: 'service_id, amount, and currency are required.',
    }
  }

  const parsedAttrs = normalizeCoverageAttributes(args.attributes ?? {})
  if (!parsedAttrs.ok) {
    return {
      ok: false,
      data: { errors: parsedAttrs.errors },
      safe_to_show: true,
      code: 'INVALID_COVERAGE_ATTRIBUTES',
      message: 'Coverage legs are invalid.',
    }
  }
  const attrs = parsedAttrs.normalized

  if (attrs.coverage_scope === 'international') {
    // The domestic north/south rule must not silently redefine international
    // coverage; preserve the explicit tool chosen by the agent/admin policy.
    return invokedAs === 'offer'
      ? executeCoverageProposeOfferIntegrated(ctx, args as never)
      : executeCoverageProposeRequest(ctx, args as never)
  }

  if (!attrs.pay_region_id || !attrs.receive_region_id) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'COVERAGE_DIRECTION_REQUIRED',
      message:
        'Both pay_region_id and receive_region_id are required for domestic coverage. Call coverage.get_rates with the customer region names first and reuse the resolved ids.',
    }
  }

  const resolved = await resolveLegs(ctx, {
    pay_region_id: attrs.pay_region_id,
    pay_method: attrs.pay_method,
    receive_region_id: attrs.receive_region_id,
    receive_method: attrs.receive_method,
  })
  if (!resolved.ok) return resolved.result
  const direction = classifyCoverageDirection(resolved.pay.macro, resolved.receive.macro)
  if (!direction.supported || !direction.kind) {
    return {
      ok: false,
      data: { resolved_legs: { pay: resolved.pay, receive: resolved.receive }, direction },
      safe_to_show: true,
      code: direction.code,
      message: direction.explanationAr,
    }
  }

  const amount = proposalAmount(args) as string
  const quote = await executeCoverageGetRatesDirectional(ctx, {
    amount,
    currency: args.currency,
    pay_region_id: attrs.pay_region_id,
    pay_method: attrs.pay_method,
    receive_region_id: attrs.receive_region_id,
    receive_method: attrs.receive_method,
  })
  if (!quote.ok) return quote
  const quoteData = quote.data as {
    quote?: { rate_per_1000?: string | null; commission_amount?: string | null }
  } | null
  const rate = quoteData?.quote?.rate_per_1000 ?? null
  if (rate === null) {
    return {
      ok: false,
      data: quote.data,
      safe_to_show: true,
      code: 'COVERAGE_RATE_UNPUBLISHED',
      message: 'The applicable coverage commission rate is not currently published.',
    }
  }

  // Customer-supplied/model-supplied commission figures are never authority.
  // The proposal snapshots the currently published board rate deterministically.
  const common = {
    service_id: args.service_id,
    currency: args.currency,
    attributes: attrs,
    commission_per_thousand: rate,
    commission_currency: args.currency,
    ...(args.deal_date ? { deal_date: args.deal_date } : {}),
  }

  const outcome = direction.kind === 'offer'
    ? await executeCoverageProposeOfferIntegrated(ctx, {
        ...common,
        total_amount: amount,
      } as never)
    : await executeCoverageProposeRequest(ctx, {
        ...common,
        requested_amount: amount,
        ...(args.expires_at ? { expires_at: args.expires_at } : {}),
      } as never)

  if (!outcome.ok) return outcome

  if (invokedAs !== direction.kind) {
    console.info(
      `[tool] coverage proposal auto-corrected invoked=${invokedAs} canonical=${direction.kind} direction=${direction.code}`,
    )
  }

  const existing =
    outcome.data && typeof outcome.data === 'object'
      ? (outcome.data as Record<string, unknown>)
      : {}
  return {
    ...outcome,
    data: {
      ...existing,
      coverage_case: {
        canonical_type: direction.kind,
        invoked_tool_type: invokedAs,
        auto_corrected: invokedAs !== direction.kind,
        direction_code: direction.code,
        commission_effect: direction.commissionEffect,
        customer_term_ar: direction.customerTermAr,
        resolved_legs: { pay: resolved.pay, receive: resolved.receive },
      },
      commission_snapshot: {
        rate_per_1000: rate,
        commission_amount: quoteData?.quote?.commission_amount ?? null,
        currency: args.currency,
        source: 'current_published_coverage_rate_board',
      },
    },
  }
}
