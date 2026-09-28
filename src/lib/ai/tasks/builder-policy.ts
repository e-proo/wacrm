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

export interface BuilderOutreachLimits {
  maxTargets?: number
  maxAttempts?: number
  followupCount?: number
  cooldownMinutes?: number
  workingHours?: string
  dailyBudget?: number
  tokenBudget?: number
  messageBudget?: number
}

export interface BuilderOutreachPolicy {
  taskTypes?: BuilderTaskTypeSelection[]
  targetScope?: {
    kind: string
    selector?: string
    values?: string[]
  }
  limits?: BuilderOutreachLimits
  approvalMode?: BuilderApprovalMode
}

const APPROVAL_RANK: Record<BuilderApprovalMode, number> = {
  none: 0,
  task: 1,
  batch: 2,
}

const LIMIT_KEYS = new Set([
  'maxTargets',
  'maxAttempts',
  'followupCount',
  'cooldownMinutes',
  'workingHours',
  'dailyBudget',
  'tokenBudget',
  'messageBudget',
])

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNonNegativeNumber(value) && Number.isInteger(value)
}

function validateLimits(raw: unknown): string | null {
  if (raw === undefined) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'outreachPolicy.limits must be an object'
  }

  const limits = raw as Record<string, unknown>
  for (const key of Object.keys(limits)) {
    if (!LIMIT_KEYS.has(key)) return `Unknown outbound limit: ${key}`
  }

  if (
    limits.maxTargets !== undefined &&
    (typeof limits.maxTargets !== 'number' ||
      !Number.isInteger(limits.maxTargets) ||
      limits.maxTargets < 1)
  ) {
    return 'limits.maxTargets must be a positive integer'
  }
  if (
    limits.maxAttempts !== undefined &&
    (typeof limits.maxAttempts !== 'number' ||
      !Number.isInteger(limits.maxAttempts) ||
      limits.maxAttempts < 1)
  ) {
    return 'limits.maxAttempts must be a positive integer'
  }
  if (
    limits.followupCount !== undefined &&
    !isNonNegativeInteger(limits.followupCount)
  ) {
    return 'limits.followupCount must be a non-negative integer'
  }
  if (
    limits.cooldownMinutes !== undefined &&
    !isNonNegativeInteger(limits.cooldownMinutes)
  ) {
    return 'limits.cooldownMinutes must be a non-negative integer'
  }
  if (
    limits.tokenBudget !== undefined &&
    !isNonNegativeInteger(limits.tokenBudget)
  ) {
    return 'limits.tokenBudget must be a non-negative integer'
  }
  if (
    limits.messageBudget !== undefined &&
    !isNonNegativeInteger(limits.messageBudget)
  ) {
    return 'limits.messageBudget must be a non-negative integer'
  }
  if (
    limits.dailyBudget !== undefined &&
    !isFiniteNonNegativeNumber(limits.dailyBudget)
  ) {
    return 'limits.dailyBudget must be a non-negative finite number'
  }
  if (
    limits.workingHours !== undefined &&
    (typeof limits.workingHours !== 'string' ||
      !/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(
        limits.workingHours,
      ))
  ) {
    return 'limits.workingHours must use HH:MM-HH:MM'
  }

  return null
}

export function validateBuilderOutreachPolicy(
  policy: Record<string, unknown>,
): string | null {
  const taskTypes = policy.taskTypes
  if (taskTypes !== undefined) {
    if (!Array.isArray(taskTypes)) {
      return 'outreachPolicy.taskTypes must be an array'
    }

    const seen = new Set<string>()
    for (const item of taskTypes) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return 'Invalid Task Type selection'
      }
      const row = item as { key?: unknown; version?: unknown }
      if (
        typeof row.key !== 'string' ||
        typeof row.version !== 'number' ||
        !Number.isInteger(row.version)
      ) {
        return 'Invalid Task Type selection'
      }
      if (!CURRENT_AGENT_TASK_PLATFORM.taskTypes.get(row.key, row.version)) {
        return `Task Type ${row.key}@${row.version} is not registered`
      }

      const id = `${row.key}@${row.version}`
      if (seen.has(id)) return `Duplicate Task Type selection: ${id}`
      seen.add(id)
    }
  }

  const targetScope = policy.targetScope
  if (targetScope !== undefined) {
    if (
      !targetScope ||
      typeof targetScope !== 'object' ||
      Array.isArray(targetScope)
    ) {
      return 'Invalid target scope'
    }

    const scope = targetScope as {
      kind?: unknown
      selector?: unknown
      values?: unknown
    }
    if (
      typeof scope.kind !== 'string' ||
      !BUILDER_TARGET_SCOPE_KINDS.includes(
        scope.kind as (typeof BUILDER_TARGET_SCOPE_KINDS)[number],
      )
    ) {
      return 'Target scope must use a registered Builder scope kind'
    }
    if (
      scope.selector !== undefined &&
      typeof scope.selector !== 'string'
    ) {
      return 'Target scope selector must be a string'
    }
    if (
      scope.values !== undefined &&
      (!Array.isArray(scope.values) ||
        scope.values.length > 100 ||
        scope.values.some(
          (value) => typeof value !== 'string' || value.trim().length === 0,
        ))
    ) {
      return 'Target scope values must be non-empty strings'
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

  return validateLimits(policy.limits)
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
  if (
    !input.outreachPolicy.targetScope ||
    typeof input.outreachPolicy.targetScope !== 'object' ||
    Array.isArray(input.outreachPolicy.targetScope)
  ) {
    return 'Outbound agents require a deterministic target scope'
  }

  const approvalMode = input.outreachPolicy.approvalMode
  if (
    typeof approvalMode !== 'string' ||
    !BUILDER_APPROVAL_MODES.includes(approvalMode as BuilderApprovalMode)
  ) {
    return 'Outbound agents require an explicit approval mode'
  }

  const configuredApprovalRank =
    APPROVAL_RANK[approvalMode as BuilderApprovalMode]
  const limits =
    input.outreachPolicy.limits &&
    typeof input.outreachPolicy.limits === 'object' &&
    !Array.isArray(input.outreachPolicy.limits)
      ? (input.outreachPolicy.limits as Record<string, unknown>)
      : {}

  for (const selection of taskTypes) {
    const row = selection as { key: string; version: number }
    const manifest = CURRENT_AGENT_TASK_PLATFORM.taskTypes.get(
      row.key,
      row.version,
    )
    if (!manifest) {
      return `Task Type ${row.key}@${row.version} is not registered`
    }

    const requiredApprovalRank = APPROVAL_RANK[manifest.requiredTaskApproval]
    if (configuredApprovalRank < requiredApprovalRank) {
      return (
        `Approval mode ${approvalMode} cannot weaken Task Type ` +
        `${manifest.key}@${manifest.version} requirement: ${manifest.requiredTaskApproval}`
      )
    }

    if (
      typeof limits.maxTargets === 'number' &&
      limits.maxTargets > manifest.maxTargets
    ) {
      return (
        `Configured maxTargets ${limits.maxTargets} exceeds ` +
        `${manifest.key}@${manifest.version} maximum ${manifest.maxTargets}`
      )
    }
    if (
      typeof limits.followupCount === 'number' &&
      limits.followupCount > manifest.followupPolicy.maxFollowups
    ) {
      return (
        `Configured followupCount ${limits.followupCount} exceeds ` +
        `${manifest.key}@${manifest.version} maximum ` +
        `${manifest.followupPolicy.maxFollowups}`
      )
    }
  }

  return null
}
