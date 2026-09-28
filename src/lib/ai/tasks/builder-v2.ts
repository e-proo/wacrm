import { getCurrentPlatformTool } from '../tools/platform/current-domain-registry'
import type { AgentRevisionToolGrant } from './capability-policy'
import {
  BASE_OUTBOUND_AGENT_CAPABILITIES,
  validateTaskManifestToolPolicy,
} from './capability-policy'
import type {
  AgentTaskApprovalMode,
  AgentTaskTypeManifest,
} from './contracts'
import type { AgentTaskTypeRegistry } from './registry'

export const AGENT_OPERATIONAL_MODES = [
  'reactive',
  'outbound',
  'both',
] as const
export type AgentOperationalMode =
  (typeof AGENT_OPERATIONAL_MODES)[number]

export interface AgentBuilderTargetScope {
  requiredTagIds: readonly string[]
  excludedTagIds: readonly string[]
  serviceIds: readonly string[]
  regionIds: readonly string[]
  domainSelector: {
    key: string
    params: Readonly<Record<string, unknown>>
  } | null
}

export interface AgentBuilderWorkingHours {
  enabled: boolean
  timezone: string
  weekdays: readonly number[]
  start: string
  end: string
}

export interface AgentBuilderTaskBinding {
  taskType: string
  taskTypeVersion: number
  targetScope: AgentBuilderTargetScope
  maxTargets: number
  maxAttemptsPerTarget: number
  maxFollowups: number
  cooldownMinutes: number
  maxNewContactsPerHour: number
  maxContactsPerAgentPerDay: number
  workingHours: AgentBuilderWorkingHours
  dailyMessageBudget: number
  dailyTokenBudget: number
  approvalMode: AgentTaskApprovalMode
}

export interface AgentBuilderV2Configuration {
  operationalMode: AgentOperationalMode
  bindings: readonly AgentBuilderTaskBinding[]
}

export interface AgentBuilderV2Issue {
  path: string
  code: string
  message: string
}

export interface AgentBuilderTaskTypeView {
  key: string
  version: number
  domain: string
  title: string
  description: string
  requiredAgentCapabilities: readonly string[]
  allowedChannels: readonly string[]
  allowedTools: readonly { key: string; version: number }[]
  requiredTaskApproval: AgentTaskApprovalMode
  followupPolicy: AgentTaskTypeManifest['followupPolicy']
  maxTargets: number
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const KEY_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/
const HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/

export function listBuilderTaskTypes(
  registry: AgentTaskTypeRegistry,
): readonly AgentBuilderTaskTypeView[] {
  return registry
    .list()
    .slice()
    .sort(
      (a, b) =>
        a.domain.localeCompare(b.domain) ||
        a.title.localeCompare(b.title) ||
        a.version - b.version,
    )
    .map((manifest) =>
      Object.freeze({
        key: manifest.key,
        version: manifest.version,
        domain: manifest.domain,
        title: manifest.title,
        description: manifest.description,
        requiredAgentCapabilities: Object.freeze([
          ...manifest.requiredAgentCapabilities,
        ]),
        allowedChannels: Object.freeze([...manifest.allowedChannels]),
        allowedTools: Object.freeze(
          manifest.allowedTools.map((tool) => Object.freeze({ ...tool })),
        ),
        requiredTaskApproval: manifest.requiredTaskApproval,
        followupPolicy: Object.freeze({ ...manifest.followupPolicy }),
        maxTargets: manifest.maxTargets,
      }),
    )
}

export function defaultBuilderTaskBinding(
  manifest: AgentTaskTypeManifest,
): AgentBuilderTaskBinding {
  const maxTargets = Math.max(1, Math.min(manifest.maxTargets, 50))
  const maxFollowups = Math.max(0, manifest.followupPolicy.maxFollowups)
  return {
    taskType: manifest.key,
    taskTypeVersion: manifest.version,
    targetScope: {
      requiredTagIds: [],
      excludedTagIds: [],
      serviceIds: [],
      regionIds: [],
      domainSelector: null,
    },
    maxTargets,
    maxAttemptsPerTarget: Math.max(1, Math.min(1 + maxFollowups, 20)),
    maxFollowups,
    cooldownMinutes: manifest.followupPolicy.minimumIntervalMinutes,
    maxNewContactsPerHour: maxTargets,
    maxContactsPerAgentPerDay: maxTargets,
    workingHours: {
      enabled: false,
      timezone: 'UTC',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      start: '09:00',
      end: '17:00',
    },
    dailyMessageBudget: Math.max(1, maxTargets * (1 + maxFollowups)),
    dailyTokenBudget: 100_000,
    approvalMode: manifest.requiredTaskApproval,
  }
}

export function validateBuilderV2Configuration(input: {
  config: AgentBuilderV2Configuration
  registry: AgentTaskTypeRegistry
  revisionToolGrants: readonly AgentRevisionToolGrant[]
}): {
  ok: boolean
  issues: readonly AgentBuilderV2Issue[]
  capabilities: readonly string[]
} {
  const issues: AgentBuilderV2Issue[] = []
  const add = (path: string, code: string, message: string) =>
    issues.push({ path, code, message })

  if (!AGENT_OPERATIONAL_MODES.includes(input.config.operationalMode)) {
    add(
      'operationalMode',
      'INVALID_OPERATIONAL_MODE',
      'Operational mode must be reactive, outbound, or both.',
    )
  }

  if (
    input.config.operationalMode === 'reactive' &&
    input.config.bindings.length > 0
  ) {
    add(
      'bindings',
      'REACTIVE_TASK_BINDING_FORBIDDEN',
      'Reactive-only agents cannot have outbound Task Type bindings.',
    )
  }

  if (
    input.config.operationalMode !== 'reactive' &&
    input.config.bindings.length === 0
  ) {
    add(
      'bindings',
      'OUTBOUND_TASK_TYPE_REQUIRED',
      'Outbound-capable agents require at least one registered Task Type.',
    )
  }

  if (input.config.bindings.length > 50) {
    add(
      'bindings',
      'TOO_MANY_TASK_BINDINGS',
      'At most 50 Task Type bindings are allowed per revision.',
    )
  }

  const seen = new Set<string>()
  const capabilities = new Set<string>()

  if (input.config.bindings.length > 0) {
    for (const capability of BASE_OUTBOUND_AGENT_CAPABILITIES) {
      capabilities.add(capability)
    }
  }

  input.config.bindings.forEach((binding, index) => {
    const path = `bindings.${index}`
    const id = `${binding.taskType}@${binding.taskTypeVersion}`
    if (seen.has(id)) {
      add(path, 'DUPLICATE_TASK_BINDING', `Duplicate Task Type binding: ${id}.`)
      return
    }
    seen.add(id)

    const manifest = input.registry.get(
      binding.taskType,
      binding.taskTypeVersion,
    )
    if (!manifest) {
      add(
        path,
        'TASK_TYPE_NOT_REGISTERED',
        `Task Type ${id} is not registered.`,
      )
      return
    }

    const toolPolicyIssues = validateTaskManifestToolPolicy(manifest)
    for (const issue of toolPolicyIssues) {
      add(path + '.tools', 'TASK_TOOL_POLICY_INVALID', issue)
    }

    for (const capability of manifest.requiredAgentCapabilities) {
      capabilities.add(capability)
    }

    const allowedToolIds = new Set(
      manifest.allowedTools.map((tool) => `${tool.key}@${tool.version}`),
    )
    for (const grant of input.revisionToolGrants) {
      const toolId = `${grant.toolKey}@${grant.toolVersion}`
      if (!allowedToolIds.has(toolId)) continue
      const tool = getCurrentPlatformTool(grant.toolKey, grant.toolVersion)
      if (!tool || tool.permission !== grant.permission) {
        add(
          path + '.tools',
          'TASK_TOOL_GRANT_INVALID',
          `Frozen tool grant does not match the platform contract: ${toolId}.`,
        )
        continue
      }
      for (const capability of tool.requiredCapabilities) {
        capabilities.add(capability)
      }
    }

    if (!manifest.allowedChannels.includes('whatsapp')) {
      add(
        path + '.channel',
        'TASK_WHATSAPP_UNSUPPORTED',
        `Task Type ${id} does not support WhatsApp.`,
      )
    }

    if (
      !Number.isInteger(binding.maxTargets) ||
      binding.maxTargets < 1 ||
      binding.maxTargets > manifest.maxTargets
    ) {
      add(
        path + '.maxTargets',
        'INVALID_MAX_TARGETS',
        `maxTargets must be 1-${manifest.maxTargets} for ${id}.`,
      )
    }

    validateInteger(
      binding.maxAttemptsPerTarget,
      1,
      20,
      path + '.maxAttemptsPerTarget',
      'INVALID_MAX_ATTEMPTS',
      add,
    )
    validateInteger(
      binding.maxFollowups,
      0,
      manifest.followupPolicy.maxFollowups,
      path + '.maxFollowups',
      'INVALID_MAX_FOLLOWUPS',
      add,
    )
    validateInteger(
      binding.cooldownMinutes,
      0,
      525_600,
      path + '.cooldownMinutes',
      'INVALID_COOLDOWN',
      add,
    )
    validateInteger(
      binding.maxNewContactsPerHour,
      1,
      10_000,
      path + '.maxNewContactsPerHour',
      'INVALID_HOURLY_CONTACT_LIMIT',
      add,
    )
    validateInteger(
      binding.maxContactsPerAgentPerDay,
      1,
      100_000,
      path + '.maxContactsPerAgentPerDay',
      'INVALID_DAILY_CONTACT_LIMIT',
      add,
    )
    validateInteger(
      binding.dailyMessageBudget,
      1,
      100_000,
      path + '.dailyMessageBudget',
      'INVALID_DAILY_MESSAGE_BUDGET',
      add,
    )
    validateInteger(
      binding.dailyTokenBudget,
      1,
      1_000_000_000,
      path + '.dailyTokenBudget',
      'INVALID_DAILY_TOKEN_BUDGET',
      add,
    )

    validateTargetScope(binding.targetScope, path + '.targetScope', add)
    validateWorkingHours(
      binding.workingHours,
      path + '.workingHours',
      add,
    )

    if (!['none', 'task', 'batch'].includes(binding.approvalMode)) {
      add(
        path + '.approvalMode',
        'INVALID_APPROVAL_MODE',
        'Approval mode must be none, task, or batch.',
      )
    } else if (
      !approvalSatisfies(
        binding.approvalMode,
        manifest.requiredTaskApproval,
      )
    ) {
      add(
        path + '.approvalMode',
        'APPROVAL_POLICY_TOO_WEAK',
        `Task Type ${id} requires at least ${manifest.requiredTaskApproval} approval.`,
      )
    }
  })

  return {
    ok: issues.length === 0,
    issues: Object.freeze(issues.map((issue) => Object.freeze({ ...issue }))),
    capabilities: Object.freeze([...capabilities].sort()),
  }
}

function approvalSatisfies(
  configured: AgentTaskApprovalMode,
  required: AgentTaskApprovalMode,
): boolean {
  if (required === 'none') return true
  if (required === 'task') return configured === 'task' || configured === 'batch'
  return configured === 'batch'
}

function validateTargetScope(
  scope: AgentBuilderTargetScope,
  path: string,
  add: (path: string, code: string, message: string) => void,
) {
  const required = validateUuidArray(
    scope.requiredTagIds,
    path + '.requiredTagIds',
    add,
  )
  const excluded = validateUuidArray(
    scope.excludedTagIds,
    path + '.excludedTagIds',
    add,
  )
  validateUuidArray(scope.serviceIds, path + '.serviceIds', add)
  validateUuidArray(scope.regionIds, path + '.regionIds', add)

  const excludedSet = new Set(excluded)
  if (required.some((id) => excludedSet.has(id))) {
    add(
      path,
      'TARGET_SCOPE_TAG_CONFLICT',
      'A tag cannot be both required and excluded.',
    )
  }

  if (scope.domainSelector) {
    if (!KEY_RE.test(scope.domainSelector.key)) {
      add(
        path + '.domainSelector.key',
        'INVALID_DOMAIN_SELECTOR',
        'Domain selector must be a stable dotted key.',
      )
    }
    if (
      !scope.domainSelector.params ||
      typeof scope.domainSelector.params !== 'object' ||
      Array.isArray(scope.domainSelector.params)
    ) {
      add(
        path + '.domainSelector.params',
        'INVALID_DOMAIN_SELECTOR_PARAMS',
        'Domain selector params must be an object.',
      )
    }
  }
}

function validateWorkingHours(
  value: AgentBuilderWorkingHours,
  path: string,
  add: (path: string, code: string, message: string) => void,
) {
  if (typeof value.enabled !== 'boolean') {
    add(path + '.enabled', 'INVALID_WORKING_HOURS', 'enabled must be boolean.')
  }
  if (
    typeof value.timezone !== 'string' ||
    !value.timezone.trim() ||
    value.timezone.length > 100
  ) {
    add(
      path + '.timezone',
      'INVALID_WORKING_HOURS_TIMEZONE',
      'A bounded IANA timezone is required.',
    )
  }
  if (!Array.isArray(value.weekdays) || value.weekdays.length > 7) {
    add(
      path + '.weekdays',
      'INVALID_WORKING_HOURS_WEEKDAYS',
      'weekdays must contain at most seven day numbers.',
    )
  } else if (
    value.weekdays.some(
      (day) => !Number.isInteger(day) || day < 0 || day > 6,
    )
  ) {
    add(
      path + '.weekdays',
      'INVALID_WORKING_HOURS_WEEKDAYS',
      'Weekdays must be integers from 0 to 6.',
    )
  }
  if (!HHMM_RE.test(value.start) || !HHMM_RE.test(value.end)) {
    add(
      path,
      'INVALID_WORKING_HOURS_TIME',
      'Working-hour start/end must be HH:MM.',
    )
  } else if (value.start >= value.end) {
    add(
      path,
      'INVALID_WORKING_HOURS_WINDOW',
      'Working-hour windows must not cross midnight.',
    )
  }
}

function validateUuidArray(
  values: readonly string[],
  path: string,
  add: (path: string, code: string, message: string) => void,
): string[] {
  if (!Array.isArray(values) || values.length > 100) {
    add(path, 'INVALID_UUID_LIST', 'Expected at most 100 IDs.')
    return []
  }
  const unique = [...new Set(values)]
  if (unique.some((value) => !UUID_RE.test(value))) {
    add(path, 'INVALID_UUID_LIST', 'Every target scope ID must be a UUID.')
  }
  return unique
}

function validateInteger(
  value: number,
  min: number,
  max: number,
  path: string,
  code: string,
  add: (path: string, code: string, message: string) => void,
) {
  if (!Number.isInteger(value) || value < min || value > max) {
    add(path, code, `Value must be an integer from ${min} to ${max}.`)
  }
}
