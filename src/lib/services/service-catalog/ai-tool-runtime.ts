import { supabaseAdmin } from '@/lib/ai/admin-client'
import { createChangeRequest } from '@/lib/ai/runtime/change-requests-service'
import { composeIdempotencyKey } from '@/lib/services/platform/idempotency'
import type { ModelToolExecutorRegistration } from '@/lib/ai/tools/platform/runtime-contracts'
import type { ToolContext, ToolResult } from '@/lib/ai/tools/executors'
import {
  compileFieldSchema,
  validateValues,
  type FieldDefinitionInput,
} from '@/lib/services/catalog/field-schema'
import { executeServicesGetSafe, executeServicesSearchSafe } from './read-tools'
import { matchServiceRequest } from './matcher'

interface ServicesMatchArgs {
  service_hint?: string
  attributes: Record<string, unknown>
  limit?: number
}

export async function executeServicesMatchRequest(
  ctx: ToolContext,
  args: ServicesMatchArgs,
): Promise<ToolResult<unknown>> {
  if (!args.attributes || typeof args.attributes !== 'object') {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message: 'attributes object is required.',
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

export interface ServiceProposeUpdateArgs {
  service_id: string
  name?: string
  public_description?: string
  ai_guidance?: string
  field_values_patch?: Record<string, unknown>
  pricing_rule_id?: string
  status?: 'draft' | 'active' | 'paused' | 'archived'
}

export async function executeServiceProposeUpdate(
  ctx: ToolContext,
  args: ServiceProposeUpdateArgs,
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
  if (!args.service_id) {
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'SERVICE_ID_REQUIRED',
      message: 'service_id is required.',
    }
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
      return {
        ok: false,
        data: null,
        safe_to_show: false,
        code: 'SERVICE_NOT_PUBLISHED',
        message: 'Service has no current revision to edit safely.',
      }
    }

    const { data: revision, error: revisionError } = await db
      .from('service_revisions')
      .select(
        'id, category_schema_version_id, public_description, ai_guidance, field_values, pricing_rule_id',
      )
      .eq('account_id', ctx.accountId)
      .eq('service_id', args.service_id)
      .eq('id', service.current_revision_id)
      .maybeSingle()
    if (revisionError) throw revisionError
    if (!revision) {
      return {
        ok: false,
        data: null,
        safe_to_show: false,
        code: 'SERVICE_REVISION_NOT_FOUND',
        message: 'Current service revision was not found.',
      }
    }

    const { data: defs, error: defsError } = await db
      .from('service_field_definitions')
      .select(
        'field_key, label, help_text, data_type, required, visibility, constraints, display_order, is_filterable',
      )
      .eq('account_id', ctx.accountId)
      .eq('schema_version_id', revision.category_schema_version_id)
    if (defsError) throw defsError

    const definitions = (defs ?? []) as FieldDefinitionInput[]
    const byKey = new Map(
      definitions.map((definition) => [definition.field_key, definition]),
    )
    const patch = args.field_values_patch ?? {}
    for (const key of Object.keys(patch)) {
      const definition = byKey.get(key)
      if (!definition) {
        return {
          ok: false,
          data: null,
          safe_to_show: false,
          code: 'SERVICE_FIELD_UNKNOWN',
          message: `Unknown service field: ${key}`,
        }
      }
      if (definition.visibility === 'internal') {
        return {
          ok: false,
          data: null,
          safe_to_show: false,
          code: 'SERVICE_FIELD_INTERNAL',
          message: `Field ${key} is internal-only and cannot be changed by an AI agent.`,
        }
      }
    }

    const mergedValues = {
      ...((revision.field_values as Record<string, unknown> | null) ?? {}),
      ...patch,
    }
    const validated = validateValues(
      compileFieldSchema(definitions),
      mergedValues,
      'full',
    )
    if (!validated.ok || !validated.normalized) {
      return {
        ok: false,
        data: { errors: validated.errors },
        safe_to_show: false,
        code: 'SERVICE_FIELDS_INVALID',
        message: 'Proposed service fields do not satisfy the service schema.',
      }
    }

    const pricingRuleId =
      args.pricing_rule_id ?? (revision.pricing_rule_id as string | null)
    if (pricingRuleId) {
      const { data: pricingRule, error: pricingError } = await db
        .from('service_pricing_rules')
        .select('id, status')
        .eq('account_id', ctx.accountId)
        .eq('id', pricingRuleId)
        .maybeSingle()
      if (pricingError) throw pricingError
      if (!pricingRule || pricingRule.status !== 'published') {
        return {
          ok: false,
          data: null,
          safe_to_show: false,
          code: 'PRICING_RULE_NOT_PUBLISHED',
          message:
            'pricing_rule_id must reference a published pricing rule in this account.',
        }
      }
    }

    const desired = {
      expected_current_revision_id: revision.id,
      name: args.name?.trim() || service.name,
      public_description:
        args.public_description ?? revision.public_description ?? null,
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
      actionKey: 'services.update',
      actionVersion: 1,
      targetType: 'service',
      targetId: args.service_id,
      intent: 'update',
      expectedVersion: Number(service.version),
      proposedPayload: desired,
      idempotencyKey: composeIdempotencyKey([
        'service-update',
        args.service_id,
        `v${service.version}`,
        changeFingerprint,
      ]),
      summary: `تعديل خدمة ${service.name} وإنشاء نسخة منشورة جديدة بعد الاعتماد`,
      actorUserId: ctx.actorUserId,
    })

    return {
      ok: true,
      data: {
        service: {
          id: service.id,
          current_version: service.version,
          current_revision_id: revision.id,
        },
        proposed: desired,
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
    console.error('[tool] service update proposal failed:', err)
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'SERVICE_UPDATE_PROPOSAL_FAILED',
      message: 'Could not create the service change proposal.',
    }
  }
}

export const SERVICES_MODEL_TOOL_EXECUTORS: readonly ModelToolExecutorRegistration[] = [
  {
    key: 'services.search',
    version: 1,
    executor: (ctx, args) => executeServicesSearchSafe(ctx, args as never),
  },
  {
    key: 'services.get',
    version: 1,
    executor: (ctx, args) => executeServicesGetSafe(ctx, args as never),
  },
  {
    key: 'services.match_request',
    version: 1,
    executor: (ctx, args) => executeServicesMatchRequest(ctx, args as never),
  },
  {
    key: 'services.propose_update',
    version: 1,
    executor: (ctx, args) => executeServiceProposeUpdate(ctx, args as never),
  },
]
