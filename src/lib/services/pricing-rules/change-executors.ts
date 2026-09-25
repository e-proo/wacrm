import { supabaseAdmin } from '@/lib/ai/admin-client'
import {
  publishPricingRuleRaw,
  ServiceError,
} from '@/lib/services/pricing/rules-crud'
import {
  DomainChangeExecutionError,
  type ChangeExecutorRegistration,
} from '@/lib/services/platform/change-executor-registry'

const createAndAttach: ChangeExecutorRegistration['executor'] = async (context, change) => {
  if (change.targetId) {
    throw new DomainChangeExecutionError(
      'PRICING_CHANGE_TARGET_UNEXPECTED',
      'A create-and-attach pricing proposal cannot target an existing rule.',
    )
  }
  const p = change.proposedPayload as {
    service_id?: string
    expected_service_version?: number
    expected_current_revision_id?: string
    name?: string
    kind?: string
    fee_currency?: string | null
    input_currency?: string | null
    minimum_fee?: string | null
    maximum_fee?: string | null
    rounding_mode?: string | null
    formula_config?: Record<string, unknown>
  }
  if (
    !p.service_id ||
    p.expected_service_version == null ||
    !p.expected_current_revision_id ||
    !p.name ||
    !p.kind ||
    !p.formula_config
  ) {
    throw new DomainChangeExecutionError(
      'PRICING_CHANGE_PAYLOAD_INCOMPLETE',
      'Approved service-pricing proposal is incomplete.',
    )
  }
  const { data: result, error } = await supabaseAdmin().rpc(
    'apply_service_pricing_change',
    {
      p_account_id: context.accountId,
      p_change_request_id: change.id,
      p_service_id: p.service_id,
      p_expected_service_version: p.expected_service_version,
      p_expected_current_revision_id: p.expected_current_revision_id,
      p_name: p.name,
      p_kind: p.kind,
      p_fee_currency: p.fee_currency ?? null,
      p_input_currency: p.input_currency ?? null,
      p_minimum_fee: p.minimum_fee ?? null,
      p_maximum_fee: p.maximum_fee ?? null,
      p_rounding_mode: p.rounding_mode ?? null,
      p_formula_config: p.formula_config,
      p_actor_user_id: context.actorUserId,
    },
  )
  if (error || !result) {
    const message = error?.message ?? 'Service pricing change failed.'
    if (
      message.includes('SERVICE_VERSION_CHANGED') ||
      message.includes('SERVICE_CURRENT_REVISION_CHANGED')
    ) {
      throw new DomainChangeExecutionError(
        'SERVICE_PRICING_VERSION_CONFLICT',
        'The service changed after this pricing proposal; review and approve a fresh proposal.',
      )
    }
    throw error ?? new DomainChangeExecutionError('SERVICE_PRICING_CHANGE_FAILED', message)
  }
  const applied = result as {
    pricing_rule_id?: string
    revision_id?: string
    idempotent?: boolean
  }
  return {
    target_type: change.targetType,
    operation: 'create_pricing_rule_and_publish_service_revision',
    service_id: p.service_id,
    pricing_rule_id: applied.pricing_rule_id ?? null,
    revision_id: applied.revision_id ?? null,
    idempotent: applied.idempotent ?? false,
  }
}

const publish: ChangeExecutorRegistration['executor'] = async (context, change) => {
  if (!change.targetId) {
    throw new DomainChangeExecutionError(
      'PRICING_RULE_TARGET_REQUIRED',
      'Approved pricing publish request is missing its target rule.',
    )
  }
  try {
    const rule = await publishPricingRuleRaw(
      context.accountId,
      change.targetId,
      context.actorUserId,
    )
    return {
      target_type: change.targetType,
      target_id: change.targetId,
      operation: 'publish',
      rule,
    }
  } catch (error) {
    if (error instanceof ServiceError) {
      throw new DomainChangeExecutionError(error.code, error.message, error.status)
    }
    throw error
  }
}

export const PRICING_RULES_CHANGE_EXECUTORS: readonly ChangeExecutorRegistration[] = [
  { actionKey: 'pricing_rules.create_and_attach', actionVersion: 1, executor: createAndAttach },
  { actionKey: 'pricing_rules.publish', actionVersion: 1, executor: publish },
]
