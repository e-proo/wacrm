import { CURRENT_AGENT_TASK_PLATFORM } from './current-platform'

export const BUILDER_OPERATIONAL_MODES = ['reactive', 'outbound', 'both'] as const
export const BUILDER_APPROVAL_MODES = ['none', 'task', 'batch'] as const
export const BUILDER_TARGET_SCOPE_KINDS = [
  'segments',
  'tags',
  'service_relationship',
  'regions',
  'predefined_filter',
  'domain_selector',
] as const

export type BuilderOperationalMode = (typeof BUILDER_OPERATIONAL_MODES)[number]
export type BuilderApprovalMode = (typeof BUILDER_APPROVAL_MODES)[number]

export interface BuilderTaskTypeSelection {
  key: string
  version: number
}

export interface BuilderOutreachPolicy {
  taskTypes?: BuilderTaskTypeSelection[]
  targetScope?: {
    kind: string
    selector?: string
    values?: string[]
  }
  limits?: Record<string, unknown>
  approvalMode?: BuilderApprovalMode
}

export function validateBuilderOutreachPolicy(
  policy: Record<string, unknown>,
): string | null {
  const taskTypes = policy.taskTypes
  if (taskTypes !== undefined) {
    if (!Array.isArray(taskTypes)) {
      return 'outreachPolicy.taskTypes must be an array'
    }
    for (const item of taskTypes) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return 'Invalid Task Type selection'
      }
      const row = item as { key?: unknown; version?: unknown }
      if (typeof row.key !== 'string' || !Number.isInteger(row.version)) {
        return 'Invalid Task Type selection'
      }
      if (!CURRENT_AGENT_TASK_PLATFORM.taskTypes.get(row.key, Number(row.version))) {
        return `Task Type ${row.key}@${row.version} is not registered`
      }
    }
  }

  const targetScope = policy.targetScope
  if (targetScope !== undefined) {
    if (!targetScope || typeof targetScope !== 'object' || Array.isArray(targetScope)) {
      return 'Invalid target scope'
    }
    const kind = (targetScope as { kind?: unknown }).kind
    if (
      typeof kind !== 'string' ||
      !BUILDER_TARGET_SCOPE_KINDS.includes(
        kind as (typeof BUILDER_TARGET_SCOPE_KINDS)[number],
      )
    ) {
      return 'Target scope must use a registered Builder scope kind'
    }
  }

  const approvalMode = policy.approvalMode
  if (
    approvalMode !== undefined &&
    !BUILDER_APPROVAL_MODES.includes(
      String(approvalMode) as BuilderApprovalMode,
    )
  ) {
    return 'Invalid approval mode'
  }

  return null
}

export function validateBuilderPublishPolicy(input: {
  operationalMode: string
  outreachPolicy: Record<string, unknown>
}): string | null {
  if (
    !BUILDER_OPERATIONAL_MODES.includes(
      input.operationalMode as BuilderOperationalMode,
    )
  ) {
    return 'Invalid operational mode'
  }

  const policyError = validateBuilderOutreachPolicy(input.outreachPolicy)
  if (policyError) return policyError

  if (input.operationalMode === 'reactive') return null

  const taskTypes = input.outreachPolicy.taskTypes
  if (!Array.isArray(taskTypes) || taskTypes.length === 0) {
    return 'Outbound agents require at least one registered Task Type'
  }

  return null
}
