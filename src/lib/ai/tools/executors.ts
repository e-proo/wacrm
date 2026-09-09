// Server-only by convention.
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { previewServiceQuote } from '@/lib/services/domain-services'
import { getCurrentExchangeRate } from '@/lib/services/domain-services'
import { matchServiceRequest } from './service-matcher'
import { recordIntent, listIntents } from '@/lib/services/intents/intents-service'
import type {
  AccountId,
  Uuid,
} from '@/lib/ai/runtime/multi-agent-types'

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
      'field_values, service_pricing_rules(id, kind, fee_currency, input_currency, formula_config)',
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
    service_pricing_rules: unknown
  } | null
  const rule = revRow?.service_pricing_rules
  return {
    ok: true,
    data: {
      id: (svc as { id: string }).id,
      name: (svc as { name: string }).name,
      code: (svc as { code: string }).code,
      category_id: (svc as { category_id: string }).category_id,
      status: (svc as { status: string }).status,
      public_description: (svc as { public_description: string | null }).public_description,
      field_values: revRow?.field_values ?? {},
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
// exchange_rates.get_current
// ------------------------------------------------------------
export interface ExchangeRatesGetCurrentArgs {
  base_currency: string
  quote_currency: string
  intent: 'customer_sells_base' | 'customer_buys_base'
  region?: string | null
  settlement?: 'cash' | 'bank' | 'wallet' | 'other' | null
}

export async function executeExchangeRatesGetCurrent(
  ctx: ToolContext,
  args: ExchangeRatesGetCurrentArgs,
): Promise<ToolResult<unknown>> {
  if (!args.base_currency || !args.quote_currency) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message: 'base_currency and quote_currency are required.',
    }
  }
  if (
    args.intent !== 'customer_sells_base' &&
    args.intent !== 'customer_buys_base'
  ) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INTENT',
      message: 'intent must be customer_sells_base or customer_buys_base.',
    }
  }
  try {
    const result = await getCurrentExchangeRate({
      accountId: ctx.accountId,
      baseCurrency: args.base_currency,
      quoteCurrency: args.quote_currency,
      intent: args.intent,
      region: args.region ?? null,
      channel: 'whatsapp',
      settlementMethod: args.settlement ?? null,
    })
    return { ok: true, data: result, safe_to_show: true }
  } catch (err) {
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'RATE_READ_FAILED',
      message: 'Could not read the current exchange rate.',
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
  let total = '0'
  let reserved = '0'
  let fulfilled = '0'
  let offerCount = 0
  for (const row of data ?? []) {
    const r = row as {
      total_amount: string
      reserved_amount: string
      fulfilled_amount: string
    }
    total = addDecimalStrings(total, r.total_amount)
    reserved = addDecimalStrings(reserved, r.reserved_amount)
    fulfilled = addDecimalStrings(fulfilled, r.fulfilled_amount)
    offerCount += 1
  }
  const headroom = addDecimalStrings(total, negDecimalStrings(reserved))
  const headroomMinusFulfilled = addDecimalStrings(
    headroom,
    negDecimalStrings(fulfilled),
  )
  const available = compareDecimalStrings(
    headroomMinusFulfilled,
    args.min_amount,
  ) >= 0
  return {
    ok: true,
    data: {
      available,
      total_amount: total,
      reserved_amount: reserved,
      fulfilled_amount: fulfilled,
      currency: args.currency,
      offer_count: offerCount,
    },
    safe_to_show: true,
  }
}

// ------------------------------------------------------------
// Minimal string-arithmetic helpers (no decimal.js dependency
// at this layer — Phase 2's pricing engine handles the more
// interesting math). These stay exact for the values we expect
// from numeric(20, 4) columns.
// ------------------------------------------------------------
function addDecimalStrings(a: string, b: string): string {
  const aNeg = a.startsWith('-')
  const bNeg = b.startsWith('-')
  if (aNeg && bNeg) {
    return '-' + addPositives(a.slice(1), b.slice(1))
  }
  if (aNeg) {
    return subPositives(b, a.slice(1))
  }
  if (bNeg) {
    return subPositives(a, b.slice(1))
  }
  return addPositives(a, b)
}

function negDecimalStrings(a: string): string {
  if (a.startsWith('-')) return a.slice(1)
  if (a === '0') return '0'
  return '-' + a
}

function compareDecimalStrings(a: string, b: string): number {
  // Treat both as big-decimal integers; scale to common exponent.
  const [ai, ad] = splitScale(a)
  const [bi, bd] = splitScale(b)
  const scale = Math.max(ad, bd)
  const an = alignToScale(ai, ad, scale)
  const bn = alignToScale(bi, bd, scale)
  // Trim leading zeros for accurate comparison.
  const as = an.replace(/^0+(?=\d)/, '')
  const bs = bn.replace(/^0+(?=\d)/, '')
  if (as.length !== bs.length) return as.length - bs.length
  return as < bs ? -1 : as > bs ? 1 : 0
}

function splitScale(n: string): [string, number] {
  const neg = n.startsWith('-')
  const body = neg ? n.slice(1) : n
  const [i, d = ''] = body.split('.')
  return [`${neg ? '-' : ''}${i}`, d.length]
}

function alignToScale(intPart: string, scale: number, target: number): string {
  const pad = target - scale
  if (pad <= 0) return intPart
  return intPart + '0'.repeat(pad)
}

function addPositives(a: string, b: string): string {
  const [ai, ad] = splitScale(a)
  const [bi, bd] = splitScale(b)
  const scale = Math.max(ad, bd)
  const an = alignToScale(ai, ad, scale)
  const bn = alignToScale(bi, bd, scale)
  const aNeg = an.startsWith('-')
  const bNeg = bn.startsWith('-')
  const aBody = aNeg ? an.slice(1) : an
  const bBody = bNeg ? bn.slice(1) : bn
  const max = Math.max(aBody.length, bBody.length)
  const ap = aBody.padStart(max, '0')
  const bp = bBody.padStart(max, '0')
  let carry = 0
  let out = ''
  for (let i = max - 1; i >= 0; i--) {
    const sum = Number(ap[i]) + Number(bp[i]) + carry
    out = (sum % 10).toString() + out
    carry = Math.floor(sum / 10)
  }
  if (carry > 0) out = carry.toString() + out
  if (aNeg && bNeg) out = '-' + out
  const head = out.slice(0, out.length - scale)
  const tail = scale > 0 ? '.' + out.slice(out.length - scale) : ''
  return (head || '0') + tail
}

function subPositives(a: string, b: string): string {
  const cmp = compareDecimalStrings(a, b)
  if (cmp === 0) return '0'
  if (cmp > 0) return addPositives(a, negatePositiveString(b))
  return '-' + addPositives(negatePositiveString(a), b)
}

function negatePositiveString(n: string): string {
  return n.startsWith('-') ? n.slice(1) : '-' + n
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

// ------------------------------------------------------------
// intents.record
// ------------------------------------------------------------
export interface IntentsRecordArgs {
  contact_id: string
  conversation_id?: string
  direction: 'offer' | 'request'
  service_hint: string
  summary?: string
  attributes?: Record<string, unknown>
  escalate_to_admin?: boolean
}

export async function executeIntentsRecord(
  ctx: ToolContext,
  args: IntentsRecordArgs,
): Promise<ToolResult<unknown>> {
  if (!args.contact_id || !args.service_hint?.trim()) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message: 'contact_id and service_hint are required.',
    }
  }
  if (args.direction !== 'offer' && args.direction !== 'request') {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message: 'direction must be "offer" or "request".',
    }
  }
  try {
    const result = await recordIntent({
      accountId: ctx.accountId,
      contactId: args.contact_id,
      conversationId: args.conversation_id ?? null,
      direction: args.direction,
      serviceHint: args.service_hint,
      summary: args.summary ?? null,
      attributes: args.attributes ?? {},
      escalateToAdmin: args.escalate_to_admin ?? false,
      actorUserId: ctx.actorUserId,
    })
    return { ok: true, data: result, safe_to_show: true }
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'INTENT_RECORD_FAILED'
    return {
      ok: false,
      data: null,
      safe_to_show: code !== 'INTENT_CREATE_FAILED',
      code,
      message: (err as { message?: string }).message ?? 'Could not record the observation.',
    }
  }
}

// ------------------------------------------------------------
// intents.search
// ------------------------------------------------------------
export interface IntentsSearchArgs {
  contact_id?: string
  status?: string
  q?: string
  limit?: number
}

export async function executeIntentsSearch(
  ctx: ToolContext,
  args: IntentsSearchArgs,
): Promise<ToolResult<unknown>> {
  const allowedStatuses = new Set([
    'new',
    'clarifying',
    'forwarded_to_admin',
    'fulfilled',
    'rejected',
    'matched',
  ])
  if (args.status && !allowedStatuses.has(args.status)) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message: `status must be one of: ${[...allowedStatuses].join(', ')}.`,
    }
  }
  try {
    const intents = await listIntents(ctx.accountId, {
      contactId: args.contact_id,
      status: args.status,
      q: args.q,
      limit: Math.min(args.limit ?? 20, 100),
    })
    return {
      ok: true,
      data: intents.map((intent) => ({
        intent_id: intent.id,
        contact_id: intent.contact_id,
        conversation_id: intent.conversation_id,
        direction: intent.direction,
        service_hint: intent.service_hint,
        summary: intent.summary,
        status: intent.status,
        attributes: intent.attributes,
        matched_service_id: intent.matched_service_id,
        created_at: intent.created_at,
      })),
      safe_to_show: true,
    }
  } catch (err) {
    console.error('[tool] intents.search failed:', err)
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'INTENT_SEARCH_FAILED',
      message: 'Could not search intents.',
    }
  }
}
