import { supabaseAdmin } from '@/lib/ai/admin-client'
import {
  compileFieldSchema,
  validateValues,
  type FieldDefinitionInput,
} from '@/lib/services/catalog/field-schema'
import {
  DomainChangeExecutionError,
  type ChangeExecutorRegistration,
} from '@/lib/services/platform/change-executor-registry'
import {
  SERVICE_REVISION_CONFLICT_MARKERS,
  errorHasAnyMarker,
  getErrorMessage,
} from '@/lib/services/platform/version-conflict'

const updateServiceExecutor: ChangeExecutorRegistration['executor'] = async (context, change) => {
  if (!change.targetId) {
    throw new DomainChangeExecutionError(
      'SERVICE_CHANGE_TARGET_REQUIRED',
      'Approved service change is missing its target service.',
    )
  }
  const p = change.proposedPayload as {
    expected_current_revision_id?: string
    name?: string
    public_description?: string | null
    ai_guidance?: string | null
    field_values?: Record<string, unknown>
    pricing_rule_id?: string | null
    service_status?: string
  }
  if (
    change.expectedVersion == null ||
    !p.expected_current_revision_id ||
    !p.name ||
    !p.service_status ||
    !p.field_values
  ) {
    throw new DomainChangeExecutionError(
      'SERVICE_CHANGE_PAYLOAD_INCOMPLETE',
      'Approved service change payload is incomplete.',
    )
  }

  const { data: currentRevision, error: currentError } = await supabaseAdmin()
    .from('service_revisions')
    .select('category_schema_version_id')
    .eq('account_id', context.accountId)
    .eq('service_id', change.targetId)
    .eq('id', p.expected_current_revision_id)
    .maybeSingle()
  if (currentError) throw currentError
  if (!currentRevision) {
    throw new DomainChangeExecutionError(
      'SERVICE_CURRENT_REVISION_CHANGED',
      'The service revision changed after this proposal was created.',
    )
  }

  const { data: defs, error: defsError } = await supabaseAdmin()
    .from('service_field_definitions')
    .select('field_key, label, help_text, data_type, required, visibility, constraints, display_order, is_filterable')
    .eq('account_id', context.accountId)
    .eq('schema_version_id', currentRevision.category_schema_version_id)
  if (defsError) throw defsError
  const checked = validateValues(
    compileFieldSchema((defs ?? []) as FieldDefinitionInput[]),
    p.field_values,
    'full',
  )
  if (!checked.ok || !checked.normalized) {
    throw new DomainChangeExecutionError(
      'SERVICE_FIELDS_INVALID',
      'Approved service fields no longer satisfy the schema.',
    )
  }

  const { data: revisionId, error } = await supabaseAdmin().rpc(
    'apply_service_agent_change',
    {
      p_account_id: context.accountId,
      p_change_request_id: change.id,
      p_service_id: change.targetId,
      p_expected_version: change.expectedVersion,
      p_expected_current_revision_id: p.expected_current_revision_id,
      p_name: p.name,
      p_public_description: p.public_description ?? null,
      p_ai_guidance: p.ai_guidance ?? null,
      p_field_values: checked.normalized,
      p_pricing_rule_id: p.pricing_rule_id ?? null,
      p_service_status: p.service_status,
      p_actor_user_id: context.actorUserId,
    },
  )
  if (error || !revisionId) {
    const message = getErrorMessage(error, 'Service change failed.')
    if (errorHasAnyMarker(error, SERVICE_REVISION_CONFLICT_MARKERS)) {
      throw new DomainChangeExecutionError(
        'SERVICE_VERSION_CONFLICT',
        'The service changed after this proposal; review a fresh proposal.',
      )
    }
    throw error ?? new DomainChangeExecutionError('SERVICE_CHANGE_FAILED', message)
  }
  return {
    target_type: change.targetType,
    target_id: change.targetId,
    operation: 'publish_new_revision',
    revision_id: revisionId as string,
  }
}

export const SERVICES_CHANGE_EXECUTORS: readonly ChangeExecutorRegistration[] = [
  { actionKey: 'services.update', actionVersion: 1, executor: updateServiceExecutor },
]
