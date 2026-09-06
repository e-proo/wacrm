import { supabaseAdmin } from '@/lib/ai/admin-client'
import { ServiceError } from '@/lib/services/domain-services'

export { ServiceError }

// ============================================================
// Pricing rules CRUD service (Phase 2 completion).
//
// Phase 2 migration 048 only created the table; this file
// exposes the typed surface that the admin UI / future AI tool
// will use. All writes are admin+ gated at the API layer.
// ============================================================

export interface PricingRuleRow {
  id: string
  account_id: string
  name: string
  kind: string
  fee_currency: string | null
  input_currency: string | null
  minimum_fee: string | null
  maximum_fee: string | null
  rounding_mode: string | null
  formula_config: Record<string, unknown>
  tax_policy: string
  status: string
  created_by: string | null
  created_at: string
  published_by: string | null
  published_at: string | null
}

export interface PricingRuleInput {
  name: string
  kind: PricingKind
  feeCurrency?: string | null
  inputCurrency?: string | null
  minimumFee?: string | null
  maximumFee?: string | null
  roundingMode?: RoundingMode | null
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

export type RoundingMode =
  | 'proportional'
  | 'ceil_started_unit'
  | 'floor_complete_unit'
  | 'nearest_unit'

const VALID_KINDS = new Set<PricingKind>([
  'fixed',
  'percentage',
  'per_unit',
  'fixed_plus_percentage',
  'tiered',
  'fx_buy_sell',
  'manual_quote',
])

const VALID_ROUNDING = new Set<RoundingMode>([
  'proportional',
  'ceil_started_unit',
  'floor_complete_unit',
  'nearest_unit',
])

export async function listPricingRules(accountId: string): Promise<PricingRuleRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('service_pricing_rules')
    .select(
      'id, account_id, name, kind, fee_currency, input_currency, minimum_fee, maximum_fee, rounding_mode, formula_config, tax_policy, status, created_by, created_at, published_by, published_at',
    )
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as unknown as PricingRuleRow[]
}

export async function getPricingRule(
  accountId: string,
  ruleId: string,
): Promise<PricingRuleRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('service_pricing_rules')
    .select(
      'id, account_id, name, kind, fee_currency, input_currency, minimum_fee, maximum_fee, rounding_mode, formula_config, tax_policy, status, created_by, created_at, published_by, published_at',
    )
    .eq('account_id', accountId)
    .eq('id', ruleId)
    .maybeSingle()
  if (error) throw error
  return (data as unknown as PricingRuleRow | null) ?? null
}

function validateInput(input: PricingRuleInput): void {
  if (!input.name?.trim()) {
    throw new ServiceError('INVALID_INPUT', 'name is required.')
  }
  if (!VALID_KINDS.has(input.kind)) {
    throw new ServiceError(
      'INVALID_KIND',
      `kind must be one of: ${[...VALID_KINDS].join(', ')}`,
    )
  }
  if (input.roundingMode && !VALID_ROUNDING.has(input.roundingMode)) {
    throw new ServiceError(
      'INVALID_ROUNDING_MODE',
      `roundingMode must be one of: ${[...VALID_ROUNDING].join(', ')}`,
    )
  }
  if (typeof input.formulaConfig !== 'object' || input.formulaConfig === null) {
    throw new ServiceError(
      'INVALID_FORMULA_CONFIG',
      'formulaConfig must be an object.',
    )
  }
}

export async function createPricingRule(
  accountId: string,
  input: PricingRuleInput,
  actorUserId: string | null,
): Promise<PricingRuleRow> {
  validateInput(input)
  const { data, error } = await supabaseAdmin()
    .from('service_pricing_rules')
    .insert({
      account_id: accountId,
      name: input.name.trim(),
      kind: input.kind,
      fee_currency: input.feeCurrency ?? null,
      input_currency: input.inputCurrency ?? null,
      minimum_fee: input.minimumFee ?? null,
      maximum_fee: input.maximumFee ?? null,
      rounding_mode: input.roundingMode ?? null,
      formula_config: input.formulaConfig,
      tax_policy: 'none',
      status: 'draft',
      created_by: actorUserId,
    })
    .select(
      'id, account_id, name, kind, fee_currency, input_currency, minimum_fee, maximum_fee, rounding_mode, formula_config, tax_policy, status, created_by, created_at, published_by, published_at',
    )
    .single()
  if (error || !data) throw error
  return data as unknown as PricingRuleRow
}

export async function updatePricingRule(
  accountId: string,
  ruleId: string,
  input: PricingRuleInput,
): Promise<PricingRuleRow> {
  validateInput(input)
  // Refuse updates on published rules — they're immutable.
  const existing = await getPricingRule(accountId, ruleId)
  if (!existing) {
    throw new ServiceError('NOT_FOUND', 'Pricing rule not found.', 404)
  }
  if (existing.status === 'published') {
    throw new ServiceError(
      'INVALID_STATE',
      'Published pricing rules are immutable.',
      409,
    )
  }
  const { data, error } = await supabaseAdmin()
    .from('service_pricing_rules')
    .update({
      name: input.name.trim(),
      kind: input.kind,
      fee_currency: input.feeCurrency ?? null,
      input_currency: input.inputCurrency ?? null,
      minimum_fee: input.minimumFee ?? null,
      maximum_fee: input.maximumFee ?? null,
      rounding_mode: input.roundingMode ?? null,
      formula_config: input.formulaConfig,
    })
    .eq('account_id', accountId)
    .eq('id', ruleId)
    .eq('status', 'draft')
    .select(
      'id, account_id, name, kind, fee_currency, input_currency, minimum_fee, maximum_fee, rounding_mode, formula_config, tax_policy, status, created_by, created_at, published_by, published_at',
    )
    .maybeSingle()
  if (error) throw error
  if (!data) {
    throw new ServiceError(
      'VERSION_CONFLICT',
      'Rule changed state. Reload and retry.',
      409,
    )
  }
  return data as unknown as PricingRuleRow
}

export async function publishPricingRuleRaw(
  accountId: string,
  ruleId: string,
  actorUserId: string | null,
): Promise<PricingRuleRow> {
  const { data: existing } = await supabaseAdmin()
    .from('service_pricing_rules')
    .select('status')
    .eq('account_id', accountId)
    .eq('id', ruleId)
    .maybeSingle()
  if (!existing) {
    throw new ServiceError('NOT_FOUND', 'Pricing rule not found.', 404)
  }
  const status = (existing as { status: string }).status
  if (status === 'published') {
    return (await getPricingRule(accountId, ruleId))!
  }
  if (status !== 'draft') {
    throw new ServiceError(
      'INVALID_STATE',
      `Rule is in state "${status}", not draft.`,
      409,
    )
  }
  const { data, error } = await supabaseAdmin()
    .from('service_pricing_rules')
    .update({
      status: 'published',
      published_at: new Date().toISOString(),
      published_by: actorUserId,
    })
    .eq('account_id', accountId)
    .eq('id', ruleId)
    .eq('status', 'draft')
    .select(
      'id, account_id, name, kind, fee_currency, input_currency, minimum_fee, maximum_fee, rounding_mode, formula_config, tax_policy, status, created_by, created_at, published_by, published_at',
    )
    .maybeSingle()
  if (error) throw error
  if (!data) {
    throw new ServiceError(
      'VERSION_CONFLICT',
      'Rule changed state. Reload and retry.',
      409,
    )
  }
  return data as unknown as PricingRuleRow
}

// ------------------------------------------------------------
// Activity events — append-only audit feed
// ------------------------------------------------------------
export interface ActivityEventRow {
  id: number
  account_id: string
  target_type: string
  target_id: string
  event_type: string
  actor_type: string
  actor_id: string | null
  payload: Record<string, unknown>
  created_at: string
}

export interface ActivityQuery {
  accountId: string
  targetType?: string
  limit?: number
  sinceId?: number
}

export async function listActivityEvents(
  query: ActivityQuery,
): Promise<ActivityEventRow[]> {
  const limit = Math.min(query.limit ?? 200, 1000)
  let q = supabaseAdmin()
    .from('service_activity_events')
    .select(
      'id, account_id, target_type, target_id, event_type, actor_type, actor_id, payload, created_at',
    )
    .eq('account_id', query.accountId)
    .order('id', { ascending: false })
    .limit(limit)
  if (query.targetType) q = q.eq('target_type', query.targetType)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as unknown as ActivityEventRow[]
}
