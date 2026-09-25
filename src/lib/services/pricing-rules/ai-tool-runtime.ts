import { supabaseAdmin } from '@/lib/ai/admin-client'
import { createChangeRequest } from '@/lib/ai/runtime/change-requests-service'
import type { ModelToolExecutorRegistration } from '@/lib/ai/tools/platform/runtime-contracts'
import type { ToolContext, ToolResult } from '@/lib/ai/tools/executors'
import {
  calculateQuote,
  type PricingKind,
  type RoundingMode,
} from '@/lib/services/pricing/engine'
import { normalizeCurrencyCode } from '@/lib/services/shared/currencies/currency-code'

export interface PricingRuleProposeServicePriceArgs {
  service_id: string
  name: string
  kind: PricingKind
  fee_currency?: string
  input_currency?: string
  minimum_fee?: string
  maximum_fee?: string
  rounding_mode?: RoundingMode
  formula_config: Record<string, unknown>
}

export async function executePricingRuleProposeServicePrice(
  ctx: ToolContext,
  args: PricingRuleProposeServicePriceArgs,
): Promise<ToolResult<unknown>> {
  if (ctx.plane !== 'admin') {
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'ADMIN_CONTEXT_REQUIRED',
      message: 'Admin context is required.',
    }
  }

  const validKinds = new Set<PricingKind>([
    'fixed',
    'percentage',
    'per_unit',
    'fixed_plus_percentage',
    'tiered',
    'fx_buy_sell',
    'manual_quote',
  ])
  const validRounding = new Set<RoundingMode>([
    'proportional',
    'ceil_started_unit',
    'floor_complete_unit',
    'nearest_unit',
  ])

  if (!args.service_id || !args.name?.trim() || !validKinds.has(args.kind)) {
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'INVALID_PRICING_RULE',
      message: 'service_id, name, and a supported pricing kind are required.',
    }
  }
  if (args.rounding_mode && !validRounding.has(args.rounding_mode)) {
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'INVALID_ROUNDING_MODE',
      message: 'Unsupported rounding mode.',
    }
  }
  if (
    !args.formula_config ||
    typeof args.formula_config !== 'object' ||
    Array.isArray(args.formula_config)
  ) {
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'INVALID_FORMULA_CONFIG',
      message: 'formula_config must be an object.',
    }
  }

  for (const [label, raw] of [
    ['minimum_fee', args.minimum_fee],
    ['maximum_fee', args.maximum_fee],
  ] as const) {
    if (
      raw !== undefined &&
      (!Number.isFinite(Number(raw)) || Number(raw) < 0)
    ) {
      return {
        ok: false,
        data: null,
        safe_to_show: false,
        code: 'INVALID_FEE_BOUND',
        message: `${label} must be a non-negative decimal.`,
      }
    }
  }
  if (
    args.minimum_fee !== undefined &&
    args.maximum_fee !== undefined &&
    Number(args.minimum_fee) > Number(args.maximum_fee)
  ) {
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'INVALID_FEE_RANGE',
      message: 'minimum_fee cannot exceed maximum_fee.',
    }
  }

  const feeCurrency =
    args.fee_currency === undefined
      ? null
      : normalizeCurrencyCode(args.fee_currency)
  const inputCurrency =
    args.input_currency === undefined
      ? null
      : normalizeCurrencyCode(args.input_currency)
  if (
    (args.fee_currency !== undefined && feeCurrency === null) ||
    (args.input_currency !== undefined && inputCurrency === null)
  ) {
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'INVALID_CURRENCY',
      message:
        'Pricing currencies must use a configured 3-8 character currency code.',
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
      {
        amount: '1000',
        currency: inputCurrency ?? feeCurrency ?? 'YER',
        attributes: {},
      },
    )
  } catch (err) {
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'INVALID_PRICING_FORMULA',
      message: err instanceof Error ? err.message : 'Invalid pricing formula.',
    }
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
      return {
        ok: false,
        data: null,
        safe_to_show: false,
        code: 'SERVICE_NOT_PUBLISHED',
        message: 'Service has no current revision to price safely.',
      }
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
      actionKey: 'pricing_rules.create_and_attach',
      actionVersion: 1,
      targetType: 'pricing_rule',
      targetId: null,
      intent: 'create_and_attach',
      proposedPayload,
      idempotencyKey:
        `service-price:${service.id}:v${service.version}:${fingerprint}`.slice(
          0,
          1200,
        ),
      summary: `تغيير تسعير خدمة ${service.name} عبر قاعدة ${args.kind} جديدة بعد الاعتماد`,
      actorUserId: ctx.actorUserId,
    })

    return {
      ok: true,
      data: {
        service: {
          id: service.id,
          name: service.name,
          version: service.version,
          current_revision_id: service.current_revision_id,
        },
        proposed_pricing_rule: proposedPayload,
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
    console.error('[tool] pricing-rule proposal failed:', err)
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'PRICING_RULE_PROPOSAL_FAILED',
      message: 'Could not create the service pricing proposal.',
    }
  }
}

export const PRICING_RULES_MODEL_TOOL_EXECUTORS: readonly ModelToolExecutorRegistration[] = [
  {
    key: 'pricing_rules.propose_service_price',
    version: 1,
    executor: (ctx, args) =>
      executePricingRuleProposeServicePrice(ctx, args as never),
  },
]
