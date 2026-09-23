// Server-only by convention.
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { previewServiceQuote } from '@/lib/services/domain-services'
import { matchServiceRequest } from './service-matcher'
import { readCoverageAttributes } from '@/lib/services/coverage/attributes'
import { supabaseAdmin as adminClient } from '@/lib/ai/admin-client'
import Decimal from 'decimal.js'
import { parseDecimal } from '@/lib/services/pricing/decimal'
import type {
  AccountId,
  Uuid,
  ToolGrantPermission,
  RunPlane,
  AgentPurpose,
} from '@/lib/ai/runtime/multi-agent-types'
import type { RuntimeFeaturePolicy } from '@/lib/ai/runtime/tool-policy'
import { projectServiceFieldsForAgent } from './service-field-visibility'

// ============================================================
// Tool executors (Phase 3).
//
// Each function in this module is the IMPLEMENTATION behind a
// tool definition in src/lib/ai/runtime/tool-registry.ts. The
// dispatcher calls them via `executeTool(key, args, ctx)` after
// validating the grant against the agent's published revision.
//
// All executors are READ-ONLY in Phase 3. Mutations go through
// the change-request approval flow (see change-requests-service).
//
// Errors are typed as `{ code, message, safe_to_show }` so the
// agent can decide whether to surface the message verbatim or
// paraphrase it.
// ============================================================

export interface ToolContext {
  accountId: AccountId
  agentId?: Uuid | null
  revisionId?: Uuid | null
  /** Optional caller for audit; null when the agent invokes directly. */
  actorUserId: string | null
  /** The run id — used to record which tool calls belong to which run. */
  runId: Uuid | null
  /**
   * The RUNNING REVISION's grants (tool_key → permission level),
   * loaded by the agent loop. executeTool DENIES any call whose tool
   * is absent here or whose claimed level exceeds the granted one —
   * this is what makes "deny by default" real instead of a comment.
   */
  grants: Record<string, ToolGrantPermission>
  /** Exact published tool version + constraints frozen into the revision. */
  grantVersions: Record<string, number>
  grantConstraints: Record<string, Record<string, unknown>>
  /** Security context is part of authorization, never inferred from prompt text. */
  plane: RunPlane
  channel: 'whatsapp'
  simulation: boolean
  trustedAdminIdentityId: string | null
  trustedAdminCapabilities: ReadonlyArray<string>
  features: RuntimeFeaturePolicy
  agentPurpose: AgentPurpose
  /** Runtime-bound business identity. Models never choose these values. */
  contactId: string | null
  conversationId: string | null
  sourceMessageId: string | null
}

export interface ToolResult<T = unknown> {
  ok: boolean
  data: T | null
  /** True when the message can be shown to the customer verbatim. */
  safe_to_show: boolean
  code?: string
  message?: string
}

export class ToolError extends Error {
  readonly code: string
  readonly safeToShow: boolean
  readonly status: number
  constructor(code: string, message: string, status = 400, safeToShow = true) {
    super(message)
    this.name = 'ToolError'
    this.code = code
    this.safeToShow = safeToShow
    this.status = status
  }
}

// ------------------------------------------------------------
// services.search
// ------------------------------------------------------------
export interface ServicesSearchArgs {
  query?: string
  category_id?: string
  limit?: number
}

export interface ServicesSearchRow {
  id: string
  name: string
  code: string
  category_id: string
  public_description: string | null
  status: string
}

export async function executeServicesSearch(
  ctx: ToolContext,
  args: ServicesSearchArgs,
): Promise<ToolResult<ServicesSearchRow[]>> {
  const limit = Math.min(args.limit ?? 10, 50)
  let q = supabaseAdmin()
    .from('services')
    .select(
      'id, name, code, category_id, public_description, status',
    )
    .eq('account_id', ctx.accountId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (args.category_id) q = q.eq('category_id', args.category_id)
  if (args.query && args.query.trim().length > 0) {
    // Use ilike on name + code — Postgres-only operators via the
    // `.or()` shorthand. ilike is sanitized by Supabase for the
    // % and _ wildcards so the admin query is treated as a
    // literal substring.
    const term = `%${args.query.trim()}%`
    q = q.or(`name.ilike.${term},code.ilike.${term}`)
  }
  const { data, error } = await q
  if (error) {
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'SEARCH_FAILED',
      message: 'Could not run the search.',
    }
  }
  return {
    ok: true,
    data: (data ?? []) as unknown as ServicesSearchRow[],
    safe_to_show: true,
  }
}

// ------------------------------------------------------------
// services.get
// ------------------------------------------------------------
export interface ServicesGetArgs {
  id_or_code: string
}

export interface ServicesGetRow {
  id: string
  name: string
  code: string
  category_id: string
  status: string
  public_description: string | null
  field_values: Record<string, unknown>
  pricing_quote: unknown | null
}

export async function executeServicesGet(
  ctx: ToolContext,
  args: ServicesGetArgs,
): Promise<ToolResult<ServicesGetRow>> {
  if (!args.id_or_code?.trim()) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message: 'id_or_code is required.',
    }
  }
  // Try UUID first; fall back to code lookup.
  const isUuid = /^[0-9a-f]{8}-/i.test(args.id_or_code)
  let q = supabaseAdmin()
    .from('services')
    .select(
      'id, name, code, category_id, status, public_description',
    )
    .eq('account_id', ctx.accountId)
    .limit(1)
  q = isUuid
    ? q.eq('id', args.id_or_code)
    : q.eq('code', args.id_or_code)
  const { data: svc, error: svcErr } = await q.maybeSingle()
  if (svcErr || !svc) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'NOT_FOUND',
      message: 'No active service matched.',
    }
  }
  // Read the published revision's field_values + pricing rule.
  const { data: rev, error: revErr } = await supabaseAdmin()
    .from('service_revisions')
    .select(
      'field_values, category_schema_version_id, service_pricing_rules(id, kind, fee_currency, input_currency, formula_config)',
    )
    .eq('account_id', ctx.accountId)
    .eq('service_id', (svc as { id: string }).id)
    .eq('status', 'published')
    .order('revision_number', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (revErr) {
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'READ_FAILED',
      message: 'Could not read the service revision.',
    }
  }
  const revRow = rev as unknown as {
    field_values: Record<string, unknown> | null
    category_schema_version_id: string
    service_pricing_rules: unknown
  } | null
  const rule = revRow?.service_pricing_rules
  const visibleFieldValues = revRow
    ? await projectServiceFieldsForAgent({
        accountId: ctx.accountId,
        schemaVersionId: revRow.category_schema_version_id,
        plane: ctx.plane,
        values: revRow.field_values,
      })
    : {}
  return {
    ok: true,
    data: {
      id: (svc as { id: string }).id,
      name: (svc as { name: string }).name,
      code: (svc as { code: string }).code,
      category_id: (svc as { category_id: string }).category_id,
      status: (svc as { status: string }).status,
      public_description: (svc as { public_description: string | null }).public_description,
      field_values: visibleFieldValues,
      pricing_quote: rule ?? null,
    } as ServicesGetRow,
    safe_to_show: true,
  }
}

// ------------------------------------------------------------
// pricing.calculate_quote
// ------------------------------------------------------------
export interface PricingCalculateQuoteArgs {
  service_id: string
  amount: string
  currency: string
  attributes?: Record<string, unknown>
}

export async function executePricingCalculateQuote(
  ctx: ToolContext,
  args: PricingCalculateQuoteArgs,
): Promise<ToolResult<unknown>> {
  if (!args.service_id || !args.amount || !args.currency) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message: 'service_id, amount, and currency are required.',
    }
  }
  try {
    const quote = await previewServiceQuote({
      accountId: ctx.accountId,
      serviceId: args.service_id,
      amount: args.amount,
      currency: args.currency,
      attributes: args.attributes,
    })
    return { ok: true, data: quote, safe_to_show: true }
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'QUOTE_FAILED'
    const message = (err as { message?: string }).message ?? 'Quote failed.'
    const safe =
      code === 'SERVICE_NOT_FOUND' ||
      code === 'SERVICE_NOT_ACTIVE' ||
      code === 'NO_PRICING_RULE' ||
      code === 'INVALID_RULE' ||
      code === 'INVALID_INPUT'
    return {
      ok: false,
      data: null,
      safe_to_show: safe,
      code,
      message,
    }
  }
}

// ------------------------------------------------------------
// coverage.check_availability
// ------------------------------------------------------------
export interface CoverageCheckAvailabilityArgs {
  service_id: string
  currency: string
  min_amount: string
}

export interface CoverageAvailabilityRow {
  available: boolean
  total_amount: string
  reserved_amount: string
  fulfilled_amount: string
  currency: string
  offer_count: number
}

export async function executeCoverageCheckAvailability(
  ctx: ToolContext,
  args: CoverageCheckAvailabilityArgs,
): Promise<ToolResult<CoverageAvailabilityRow>> {
  if (!args.service_id || !args.currency || !args.min_amount) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message: 'service_id, currency, and min_amount are required.',
    }
  }
  // The "available" math is a pure read: sum(total - reserved -
  // fulfilled) across active offers of the given service +
  // currency. The function returns `available: true` only when
  // the aggregated headroom meets `min_amount`.
  const { data, error } = await supabaseAdmin()
    .from('coverage_offers')
    .select(
      'total_amount, reserved_amount, fulfilled_amount, currency',
    )
    .eq('account_id', ctx.accountId)
    .eq('service_id', args.service_id)
    .eq('currency', args.currency)
    .in('status', ['active', 'partially_reserved'])
  if (error) {
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'READ_FAILED',
      message: 'Could not read coverage offers.',
    }
  }
  let total = new Decimal(0)
  let reserved = new Decimal(0)
  let fulfilled = new Decimal(0)
  let offerCount = 0
  for (const row of data ?? []) {
    const r = row as {
      total_amount: string
      reserved_amount: string
      fulfilled_amount: string
    }
    total = total.plus(r.total_amount)
    reserved = reserved.plus(r.reserved_amount)
    fulfilled = fulfilled.plus(r.fulfilled_amount)
    offerCount += 1
  }
  const headroom = Decimal.max(total.minus(reserved).minus(fulfilled), 0)
  const available = headroom.greaterThanOrEqualTo(new Decimal(args.min_amount))
  return {
    ok: true,
    data: {
      available,
      total_amount: total.toFixed(),
      reserved_amount: reserved.toFixed(),
      fulfilled_amount: fulfilled.toFixed(),
      currency: args.currency,
      offer_count: offerCount,
    },
    safe_to_show: true,
  }
}

// ------------------------------------------------------------
// coverage.find_offers — anonymized provider view.
// The runtime may see which contact supplies liquidity (to route
// the admin decision), but the result handed to the model strips
// provider identity and cost so it can never leak to the
// requesting customer.
// ------------------------------------------------------------
export interface CoverageFindOffersArgs {
  service_id: string
  currency: string
  min_available?: string
  receive_region_id?: string
  receive_macro?: 'north' | 'south' | 'international'
  receive_method?: 'cash' | 'networks' | 'remittance' | 'bank_deposit' | 'any'
  limit?: number
}

export async function executeCoverageFindOffers(
  ctx: ToolContext,
  args: CoverageFindOffersArgs,
): Promise<ToolResult<unknown>> {
  if (!args.service_id || !args.currency) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message: 'service_id and currency are required.',
    }
  }
  try {
    const db = adminClient()
    const [offersRes, regionsRes] = await Promise.all([
      db
        .from('coverage_offers')
        .select(
          'id, reference_code, total_amount, reserved_amount, fulfilled_amount, currency, commission_per_thousand, commission_currency, attributes, provider_cost, status',
        )
        .eq('account_id', ctx.accountId)
        .eq('service_id', args.service_id)
        .eq('currency', args.currency)
        .in('status', ['active', 'partially_reserved']),
      args.receive_macro
        ? db
            .from('coverage_regions')
            .select('id, macro_region')
            .eq('account_id', ctx.accountId)
            .eq('status', 'active')
            .eq('macro_region', args.receive_macro)
        : Promise.resolve({ data: null, error: null }),
    ])
    if (offersRes.error) throw offersRes.error
    if (regionsRes.error) throw regionsRes.error
    const minAvailable = new Decimal(args.min_available ?? '0')
    const macroRegionIds = new Set(
      ((regionsRes.data ?? []) as Array<{ id: string }>).map((r) => r.id),
    )
    const rows = (offersRes.data ?? []) as Array<{
      id: string
      reference_code: string
      total_amount: string
      reserved_amount: string
      fulfilled_amount: string
      currency: string
      commission_per_thousand: string | null
      commission_currency: string | null
      attributes: Record<string, unknown>
      provider_cost: string | null
      status: string
    }>
    const safe = rows
      .map((row) => {
        const attrs = readCoverageAttributes(row.attributes)
        const availableAmount = Decimal.max(
          new Decimal(row.total_amount)
            .minus(row.reserved_amount)
            .minus(row.fulfilled_amount),
          0,
        ).toFixed()
        return {
          offer_id: row.id,
          reference_code: row.reference_code,
          available_amount: availableAmount,
          currency: row.currency,
          commission_per_thousand: row.commission_per_thousand,
          commission_currency: row.commission_currency ?? row.currency,
          attributes: attrs,
        }
      })
      .filter((row) => new Decimal(row.available_amount).greaterThanOrEqualTo(minAvailable))
      .filter((row) =>
        args.receive_region_id
          ? row.attributes.receive_region_id === args.receive_region_id
          : true,
      )
      .filter((row) =>
        args.receive_macro
          ? row.attributes.receive_region_id !== null &&
            macroRegionIds.has(row.attributes.receive_region_id)
          : true,
      )
      .filter((row) =>
        args.receive_method
          ? row.attributes.receive_method === args.receive_method ||
            row.attributes.receive_method === 'any' ||
            args.receive_method === 'any'
          : true,
      )
      .slice(0, Math.min(args.limit ?? 10, 50))

    if (ctx.plane === 'customer') {
      // Customers get aggregate liquidity only. Internal offer UUIDs and
      // reference codes stay on the admin plane.
      const totalAvailable = safe.reduce(
        (sum, row) => sum.plus(row.available_amount),
        new Decimal(0),
      )
      return {
        ok: true,
        data: {
          available: safe.length > 0,
          total_available: totalAvailable.toFixed(),
          currency: args.currency,
          matching_offer_count: safe.length,
        },
        safe_to_show: true,
      }
    }
    return { ok: true, data: safe, safe_to_show: false }
  } catch (err) {
    console.error('[tool] coverage.find_offers failed:', err)
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'COVERAGE_SEARCH_FAILED',
      message: 'Could not search coverage offers.',
    }
  }
}

// ------------------------------------------------------------
// coverage.get_rates — read the account's CURRENT published
// commission rate board (migration 062). Returns only the rates
// actually published; a missing field means "no figure" — the
// agent must not invent one.
// ------------------------------------------------------------
export interface CoverageGetRatesArgs {
  scope?: 'north' | 'south' | 'international' | 'all'
}

interface RateCardRow {
  id: string
  north_cash: string | null
  north_remit: string | null
  north_coverage: string | null
  south_cash: string | null
  south_remit: string | null
  south_coverage: string | null
  intl_cash: string | null
      intl_remit: string | null
      intl_coverage: string | null
      created_at: string
    }

export async function executeCoverageGetRates(
  ctx: ToolContext,
  args: CoverageGetRatesArgs,
): Promise<ToolResult<unknown>> {
  try {
    const db = adminClient()
    // NOTE: the card's `notes` column is internal desk context
    // ("why the board changed") — deliberately NOT selected here:
    // everything this tool returns is flagged safe_to_show and the
    // customer-facing agent may quote it.
    const { data, error } = await db
      .from('coverage_commission_cards')
      .select(
        'id, north_cash, north_remit, north_coverage, south_cash, south_remit, south_coverage, intl_cash, intl_remit, intl_coverage, created_at',
      )
      .eq('account_id', ctx.accountId)
      .eq('is_current', true)
      .maybeSingle()
    if (error) throw error
    if (!data) {
      return { ok: true, data: { published: false }, safe_to_show: true }
    }
    const row = data as RateCardRow
    const scope = args.scope ?? 'all'
    const markets: Array<'north' | 'south' | 'international'> =
      scope === 'all' ? ['north', 'south', 'international'] : [scope]
    const result: Record<string, unknown> = {
      published: true,
      unit: 'per 1000 (e.g. 7 = 7,000 per 1,000,000)',
      updated_at: row.created_at,
      markets: {} as Record<string, unknown>,
    }
    const marketsOut = result.markets as Record<string, unknown>
    for (const m of markets) {
      if (m === 'north') {
        marketsOut.north = {
          cash_per_1000: row.north_cash,
          remittance_per_1000: row.north_remit,
          coverage_per_1000: row.north_coverage,
        }
      } else if (m === 'south') {
        marketsOut.south = {
          cash_per_1000: row.south_cash,
          remittance_per_1000: row.south_remit,
          coverage_per_1000: row.south_coverage,
        }
      } else {
        marketsOut.international = {
          cash_per_1000: row.intl_cash,
          remittance_per_1000: row.intl_remit,
          coverage_per_1000: row.intl_coverage,
        }
      }
    }
    return { ok: true, data: result, safe_to_show: true }
  } catch (err) {
    console.error('[tool] coverage.get_rates failed:', err)
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'COVERAGE_RATES_READ_FAILED',
      message: 'Could not read the commission rate board.',
    }
  }
}

// ------------------------------------------------------------
// coverage.propose_offer — propose → admin approval → deterministic
// creation. The offer row is created here as DRAFT only when the
// change request is APPROVED (see executor below); the tool itself
// only records the proposal.
// ------------------------------------------------------------
export interface CoverageProposeOfferArgs {
  contact_id: string
  service_id: string
  total_amount: string
  currency: string
  attributes?: Record<string, unknown>
  commission_per_thousand?: string
  commission_currency?: string
  deal_date?: string
}

export async function executeCoverageProposeOffer(
  ctx: ToolContext,
  args: CoverageProposeOfferArgs,
): Promise<ToolResult<unknown>> {
  if (
    !args.contact_id ||
    !args.service_id ||
    !args.total_amount ||
    !args.currency
  ) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message: 'contact_id, service_id, total_amount, and currency are required.',
    }
  }
  const amount = parseDecimal(args.total_amount, { rejectZero: true })
  if (!amount || amount.isNegative()) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message: 'total_amount must be a positive number.',
    }
  }
  // Validate the structured coverage legs early so the admin sees a
  // clean proposal, never a malformed one.
  const attrs = readCoverageAttributes(args.attributes)
  if (
    args.attributes &&
    Object.keys(args.attributes).some(
      (k) =>
        ![
          'coverage_scope',
          'coverage_country',
          'receive_region_id',
          'receive_method',
          'pay_region_id',
          'pay_method',
        ].includes(k),
    )
  ) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message:
        'attributes may only contain: coverage_scope, coverage_country, receive_region_id, receive_method, pay_region_id, pay_method.',
    }
  }
  if (args.commission_per_thousand !== undefined) {
    const rate = parseDecimal(args.commission_per_thousand)
    if (!rate || rate.isNegative()) {
      return {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'INVALID_INPUT',
        message: 'commission_per_thousand must be a non-negative number.',
      }
    }
    if (!args.commission_currency) {
      return {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'INVALID_INPUT',
        message: 'commission_currency is required when commission_per_thousand is set.',
      }
    }
  }
  try {
    const escalation = await recordIntent({
      accountId: ctx.accountId,
      contactId: args.contact_id,
      conversationId: null,
      direction: 'offer',
      serviceHint: 'coverage offer',
      summary: `Coverage offer proposal: ${args.total_amount} ${args.currency}${
        args.commission_per_thousand !== undefined
          ? ` @ ${args.commission_per_thousand}/1000 ${args.commission_currency}`
          : ''
      }`,
      attributes: {
        service_id: args.service_id,
        total_amount: args.total_amount,
        currency: args.currency,
        ...attrs,
        ...(args.commission_per_thousand !== undefined
          ? {
              commission_per_thousand: args.commission_per_thousand,
              commission_currency: args.commission_currency,
            }
          : {}),
        ...(args.deal_date ? { deal_date: args.deal_date } : {}),
      },
      escalateToAdmin: true,
      actorUserId: ctx.actorUserId,
    })
    if (!escalation.changeRequest) {
      return {
        ok: false,
        data: null,
        safe_to_show: false,
        code: 'ESCALATION_FAILED',
        message: 'Escalation change request could not be created.',
      }
    }
    return {
      ok: true,
      data: {
        intent: {
          intent_id: escalation.intentId,
          status: escalation.status,
        },
        change_request: escalation.changeRequest,
      },
      safe_to_show: true,
    }
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'PROPOSAL_FAILED'
    return {
      ok: false,
      data: null,
      safe_to_show: code !== 'INTENT_CREATE_FAILED',
      code,
      message: (err as { message?: string }).message ?? 'Could not record the proposal.',
    }
  }
}

// ------------------------------------------------------------
// services.match_request
// ------------------------------------------------------------
export interface ServicesMatchRequestArgs {
  service_hint?: string
  attributes?: Record<string, unknown>
  limit?: number
}

export async function executeServicesMatchRequest(
  ctx: ToolContext,
  args: ServicesMatchRequestArgs,
): Promise<ToolResult<unknown>> {
  if (!args.attributes || typeof args.attributes !== 'object' || Array.isArray(args.attributes)) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message: 'attributes must be an object of what the customer said.',
    }
  }
  try {
    const result = await matchServiceRequest({
      accountId: ctx.accountId,
      serviceHint: args.service_hint,
      attributes: args.attributes,
      limit: args.limit,
    })
    return { ok: true, data: result, safe_to_show: true }
  } catch (err) {
    console.error('[tool] services.match_request failed:', err)
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'MATCH_FAILED',
      message: 'Could not run the service match.',
    }
  }
}
