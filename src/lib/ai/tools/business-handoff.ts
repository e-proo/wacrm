import { supabaseAdmin } from '@/lib/ai/admin-client'
import { createChangeRequest, listChangeRequests } from '@/lib/ai/runtime/change-requests-service'
import { compileFieldSchema, validateValues, type FieldDefinitionInput } from '@/lib/services/catalog/field-schema'
import { calculateQuote, type PricingKind, type RoundingMode } from '@/lib/services/pricing/engine'
import type { ToolContext, ToolResult } from './executors'

export async function executeCoverageAdminListOffers(
  ctx: ToolContext,
  args: { status?: string; limit?: number },
): Promise<ToolResult<unknown>> {
  try {
    let q = supabaseAdmin()
      .from('coverage_offers')
      .select('id, reference_code, service_id, provider_contact_id, total_amount, reserved_amount, fulfilled_amount, currency, attributes, commission_per_thousand, commission_currency, provider_cost, provider_cost_currency, deal_date, expires_at, status, created_at')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .limit(Math.min(args.limit ?? 20, 100))
    if (args.status) q = q.eq('status', args.status)
    const { data, error } = await q
    if (error) throw error
    return { ok: true, data: data ?? [], safe_to_show: false }
  } catch (err) {
    console.error('[tool] admin coverage offers failed:', err)
    return { ok: false, data: null, safe_to_show: false, code: 'COVERAGE_ADMIN_READ_FAILED', message: 'Could not read coverage offers.' }
  }
}

export async function executeCoverageAdminListRequests(
  ctx: ToolContext,
  args: { status?: string; limit?: number },
): Promise<ToolResult<unknown>> {
  try {
    let q = supabaseAdmin()
      .from('coverage_requests')
      .select('id, service_id, requester_contact_id, requested_amount, reserved_amount, fulfilled_amount, currency, attributes, quote_snapshot, commission_per_thousand, commission_currency, deal_date, expires_at, priority, notes, status, created_at')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .limit(Math.min(args.limit ?? 20, 100))
    if (args.status) q = q.eq('status', args.status)
    const { data, error } = await q
    if (error) throw error
    return { ok: true, data: data ?? [], safe_to_show: false }
  } catch (err) {
    console.error('[tool] admin coverage requests failed:', err)
    return { ok: false, data: null, safe_to_show: false, code: 'COVERAGE_ADMIN_READ_FAILED', message: 'Could not read coverage requests.' }
  }
}

export async function executeChangeRequestsListPending(
  ctx: ToolContext,
  args: { limit?: number },
): Promise<ToolResult<unknown>> {
  try {
    const rows = await listChangeRequests(ctx.accountId, {
      status: 'pending',
      limit: Math.min(args.limit ?? 20, 100),
    })
    return {
      ok: true,
      data: rows.map((row) => ({
        id: row.id,
        code: row.code,
        target_type: row.target_type,
        target_id: row.target_id,
        intent: row.intent,
        summary: row.summary,
        proposed_payload: row.proposed_payload,
        created_at: row.created_at,
        expires_at: row.expires_at,
      })),
      safe_to_show: false,
    }
  } catch (err) {
    console.error('[tool] pending changes read failed:', err)
    return { ok: false, data: null, safe_to_show: false, code: 'CHANGE_REQUEST_READ_FAILED', message: 'Could not read pending changes.' }
  }
}

export async function executeIntentProposeDecision(
  ctx: ToolContext,
  args: {
    intent_id: string
    decision: 'fulfilled' | 'rejected' | 'matched' | 'clarifying'
    matched_service_id?: string
    reason?: string
  },
): Promise<ToolResult<unknown>> {
  const allowed = new Set(['fulfilled', 'rejected', 'matched', 'clarifying'])
  if (!args.intent_id || !allowed.has(args.decision)) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message: 'intent_id and a valid decision are required.',
    }
  }
  if (args.decision === 'matched' && !args.matched_service_id) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'MATCHED_SERVICE_REQUIRED',
      message: 'matched_service_id is required when decision=matched.',
    }
  }
  try {
    const { data: intent, error } = await supabaseAdmin()
      .from('customer_intents')
      .select('id, service_hint, status')
      .eq('account_id', ctx.accountId)
      .eq('id', args.intent_id)
      .maybeSingle()
    if (error) throw error
    if (!intent) {
      return { ok: false, data: null, safe_to_show: true, code: 'INTENT_NOT_FOUND', message: 'Customer intent was not found.' }
    }
    const cr = await createChangeRequest({
      accountId: ctx.accountId,
      targetType: 'service_intent',
      targetId: args.intent_id,
      intent: 'update',
      proposedPayload: {
        decision: args.decision,
        ...(args.matched_service_id ? { matched_service_id: args.matched_service_id } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
      },
      idempotencyKey: `intent-decision:${args.intent_id}:${args.decision}:${args.matched_service_id ?? ''}`,
      summary: `قرار إداري للحالة: ${(intent as { service_hint: string }).service_hint} → ${args.decision}`,
      actorUserId: ctx.actorUserId,
    })
    return {
      ok: true,
      data: {
        change_request: {
          id: cr.id,
          code: cr.code,
          confirmation_code: cr.confirmationCode,
          status: cr.status,
        },
      },
      safe_to_show: false,
    }
  } catch (err) {
    console.error('[tool] intent decision proposal failed:', err)
    return { ok: false, data: null, safe_to_show: false, code: 'INTENT_DECISION_PROPOSAL_FAILED', message: 'Could not create the intent decision proposal.' }
  }
}

export async function executeServiceProposeUpdate(
  ctx: ToolContext,
  args: {
    service_id: string
    name?: string
    public_description?: string
    ai_guidance?: string
    field_values_patch?: Record<string, unknown>
    pricing_rule_id?: string
    status?: 'draft' | 'active' | 'paused' | 'archived'
  },
): Promise<ToolResult<unknown>> {
  if (ctx.plane !== 'admin') {
    return { ok: false, data: null, safe_to_show: false, code: 'ADMIN_CONTEXT_REQUIRED', message: 'Admin context is required.' }
  }
  if (!args.service_id) {
    return { ok: false, data: null, safe_to_show: false, code: 'SERVICE_ID_REQUIRED', message: 'service_id is required.' }
  }
  try {
    const db = supabaseAdmin()
    const { data: service, error: serviceError } = await db
      .from('services')
      .select('id, name, status, version, current_revision_id')
      .eq('account_id', ctx.accountId)
      .eq('id', args.service_id)
      .maybeSingle()
    if (serviceError) throw serviceError
    if (!service?.current_revision_id) {
      return { ok: false, data: null, safe_to_show: false, code: 'SERVICE_NOT_PUBLISHED', message: 'Service has no current revision to edit safely.' }
    }
    const { data: revision, error: revisionError } = await db
      .from('service_revisions')
      .select('id, category_schema_version_id, public_description, ai_guidance, field_values, pricing_rule_id')
      .eq('account_id', ctx.accountId)
      .eq('service_id', args.service_id)
      .eq('id', service.current_revision_id)
      .maybeSingle()
    if (revisionError) throw revisionError
    if (!revision) {
      return { ok: false, data: null, safe_to_show: false, code: 'SERVICE_REVISION_NOT_FOUND', message: 'Current service revision was not found.' }
    }

    const { data: defs, error: defsError } = await db
      .from('service_field_definitions')
      .select('field_key, label, help_text, data_type, required, visibility, constraints, display_order, is_filterable')
      .eq('account_id', ctx.accountId)
      .eq('schema_version_id', revision.category_schema_version_id)
    if (defsError) throw defsError
    const definitions = (defs ?? []) as FieldDefinitionInput[]
    const byKey = new Map(definitions.map((d) => [d.field_key, d]))
    const patch = args.field_values_patch ?? {}
    for (const key of Object.keys(patch)) {
      const def = byKey.get(key)
      if (!def) {
        return { ok: false, data: null, safe_to_show: false, code: 'SERVICE_FIELD_UNKNOWN', message: `Unknown service field: ${key}` }
      }
      if (def.visibility === 'internal') {
        return { ok: false, data: null, safe_to_show: false, code: 'SERVICE_FIELD_INTERNAL', message: `Field ${key} is internal-only and cannot be changed by an AI agent.` }
      }
    }
    const mergedValues = {
      ...((revision.field_values as Record<string, unknown> | null) ?? {}),
      ...patch,
    }
    const validated = validateValues(compileFieldSchema(definitions), mergedValues, 'full')
    if (!validated.ok || !validated.normalized) {
      return {
        ok: false,
        data: { errors: validated.errors },
        safe_to_show: false,
        code: 'SERVICE_FIELDS_INVALID',
        message: 'Proposed service fields do not satisfy the service schema.',
      }
    }

    const pricingRuleId = args.pricing_rule_id ?? (revision.pricing_rule_id as string | null)
    if (pricingRuleId) {
      const { data: pricingRule, error: pricingError } = await db
        .from('service_pricing_rules')
        .select('id, status')
        .eq('account_id', ctx.accountId)
        .eq('id', pricingRuleId)
        .maybeSingle()
      if (pricingError) throw pricingError
      if (!pricingRule || pricingRule.status !== 'published') {
        return { ok: false, data: null, safe_to_show: false, code: 'PRICING_RULE_NOT_PUBLISHED', message: 'pricing_rule_id must reference a published pricing rule in this account.' }
      }
    }

    const desired = {
      expected_current_revision_id: revision.id,
      name: args.name?.trim() || service.name,
      public_description: args.public_description ?? revision.public_description ?? null,
      ai_guidance: args.ai_guidance ?? revision.ai_guidance ?? null,
      field_values: validated.normalized,
      pricing_rule_id: pricingRuleId,
      service_status: args.status ?? service.status,
    }
    const changeFingerprint = JSON.stringify({
      name: desired.name,
      public_description: desired.public_description,
      ai_guidance: desired.ai_guidance,
      field_values: desired.field_values,
      pricing_rule_id: desired.pricing_rule_id,
      service_status: desired.service_status,
    })
    const cr = await createChangeRequest({
      accountId: ctx.accountId,
      targetType: 'service',
      targetId: args.service_id,
      intent: 'update',
      expectedVersion: Number(service.version),
      proposedPayload: desired,
      idempotencyKey: `service-update:${args.service_id}:v${service.version}:${changeFingerprint}`.slice(0, 1200),
      summary: `تعديل خدمة ${service.name} وإنشاء نسخة منشورة جديدة بعد الاعتماد`,
      actorUserId: ctx.actorUserId,
    })
    return {
      ok: true,
      data: {
        service: { id: service.id, current_version: service.version, current_revision_id: revision.id },
        proposed: desired,
        change_request: { id: cr.id, code: cr.code, confirmation_code: cr.confirmationCode, status: cr.status },
      },
      safe_to_show: false,
    }
  } catch (err) {
    console.error('[tool] service update proposal failed:', err)
    return { ok: false, data: null, safe_to_show: false, code: 'SERVICE_UPDATE_PROPOSAL_FAILED', message: 'Could not create the service change proposal.' }
  }
}

export async function executePricingRuleProposeServicePrice(
  ctx: ToolContext,
  args: {
    service_id: string
    name: string
    kind: PricingKind
    fee_currency?: string
    input_currency?: string
    minimum_fee?: string
    maximum_fee?: string
    rounding_mode?: RoundingMode
    formula_config: Record<string, unknown>
  },
): Promise<ToolResult<unknown>> {
  if (ctx.plane !== 'admin') {
    return { ok: false, data: null, safe_to_show: false, code: 'ADMIN_CONTEXT_REQUIRED', message: 'Admin context is required.' }
  }
  const validKinds = new Set<PricingKind>([
    'fixed', 'percentage', 'per_unit', 'fixed_plus_percentage',
    'tiered', 'fx_buy_sell', 'manual_quote',
  ])
  const validRounding = new Set<RoundingMode>([
    'proportional', 'ceil_started_unit', 'floor_complete_unit', 'nearest_unit',
  ])
  if (!args.service_id || !args.name?.trim() || !validKinds.has(args.kind)) {
    return { ok: false, data: null, safe_to_show: false, code: 'INVALID_PRICING_RULE', message: 'service_id, name, and a supported pricing kind are required.' }
  }
  if (args.rounding_mode && !validRounding.has(args.rounding_mode)) {
    return { ok: false, data: null, safe_to_show: false, code: 'INVALID_ROUNDING_MODE', message: 'Unsupported rounding mode.' }
  }
  if (!args.formula_config || typeof args.formula_config !== 'object' || Array.isArray(args.formula_config)) {
    return { ok: false, data: null, safe_to_show: false, code: 'INVALID_FORMULA_CONFIG', message: 'formula_config must be an object.' }
  }
  for (const [label, raw] of [['minimum_fee', args.minimum_fee], ['maximum_fee', args.maximum_fee]] as const) {
    if (raw !== undefined && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) {
      return { ok: false, data: null, safe_to_show: false, code: 'INVALID_FEE_BOUND', message: `${label} must be a non-negative decimal.` }
    }
  }
  if (args.minimum_fee !== undefined && args.maximum_fee !== undefined && Number(args.minimum_fee) > Number(args.maximum_fee)) {
    return { ok: false, data: null, safe_to_show: false, code: 'INVALID_FEE_RANGE', message: 'minimum_fee cannot exceed maximum_fee.' }
  }
  const feeCurrency = args.fee_currency?.trim().toUpperCase() || null
  const inputCurrency = args.input_currency?.trim().toUpperCase() || null
  for (const code of [feeCurrency, inputCurrency]) {
    if (code && !/^[A-Z_]{3,8}$/.test(code)) {
      return { ok: false, data: null, safe_to_show: false, code: 'INVALID_CURRENCY', message: 'Pricing currencies must be configured uppercase currency codes.' }
    }
  }

  try {
    calculateQuote(
      {
        id: 'proposal-validation',
        kind: args.kind,
        feeCurrency,
        inputCurrency,
        minimumFee: args.minimum_fee ?? null,
        maximumFee: args.maximum_fee ?? null,
        roundingMode: args.rounding_mode ?? null,
        formulaConfig: args.formula_config,
      },
      { amount: '1000', currency: inputCurrency ?? feeCurrency ?? 'YER', attributes: {} },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid pricing formula.'
    return { ok: false, data: null, safe_to_show: false, code: 'INVALID_PRICING_FORMULA', message }
  }

  try {
    const db = supabaseAdmin()
    const { data: service, error } = await db
      .from('services')
      .select('id, name, version, current_revision_id, status')
      .eq('account_id', ctx.accountId)
      .eq('id', args.service_id)
      .maybeSingle()
    if (error) throw error
    if (!service?.current_revision_id) {
      return { ok: false, data: null, safe_to_show: false, code: 'SERVICE_NOT_PUBLISHED', message: 'Service has no current revision to price safely.' }
    }

    const proposedPayload = {
      service_id: service.id,
      expected_service_version: Number(service.version),
      expected_current_revision_id: service.current_revision_id,
      name: args.name.trim(),
      kind: args.kind,
      fee_currency: feeCurrency,
      input_currency: inputCurrency,
      minimum_fee: args.minimum_fee ?? null,
      maximum_fee: args.maximum_fee ?? null,
      rounding_mode: args.rounding_mode ?? null,
      formula_config: args.formula_config,
    }
    const fingerprint = JSON.stringify(proposedPayload)
    const cr = await createChangeRequest({
      accountId: ctx.accountId,
      targetType: 'pricing_rule',
      targetId: null,
      intent: 'create_and_attach',
      proposedPayload,
      idempotencyKey: `service-price:${service.id}:v${service.version}:${fingerprint}`.slice(0, 1200),
      summary: `تغيير تسعير خدمة ${service.name} عبر قاعدة ${args.kind} جديدة بعد الاعتماد`,
      actorUserId: ctx.actorUserId,
    })
    return {
      ok: true,
      data: {
        service: { id: service.id, name: service.name, version: service.version, current_revision_id: service.current_revision_id },
        proposed_pricing_rule: proposedPayload,
        change_request: { id: cr.id, code: cr.code, confirmation_code: cr.confirmationCode, status: cr.status },
      },
      safe_to_show: false,
    }
  } catch (err) {
    console.error('[tool] pricing-rule proposal failed:', err)
    return { ok: false, data: null, safe_to_show: false, code: 'PRICING_RULE_PROPOSAL_FAILED', message: 'Could not create the service pricing proposal.' }
  }
}
