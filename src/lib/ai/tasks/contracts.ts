import type { Channel, Uuid } from '../runtime/multi-agent-types'

export const AGENT_TASK_TRIGGERS = [
  'manual',
  'scheduled',
  'business_event',
  'system',
] as const
export type AgentTaskTrigger = (typeof AGENT_TASK_TRIGGERS)[number]

export const AGENT_TASK_STATUSES = [
  'draft',
  'validating',
  'scheduled',
  'queued',
  'running',
  'paused',
  'completed',
  'partially_completed',
  'failed',
  'cancelled',
] as const
export type AgentTaskStatus = (typeof AGENT_TASK_STATUSES)[number]

export type AgentTaskApprovalMode = 'none' | 'task' | 'batch'

export interface AgentTask {
  id: Uuid
  accountId: string
  taskType: string
  taskTypeVersion: number
  agentId: Uuid
  /**
   * Frozen at task creation/activation. A long-running task must not silently
   * change behavior when the agent publishes a newer revision.
   */
  agentRevisionId: Uuid
  triggerType: AgentTaskTrigger
  triggerRef: string | null
  status: AgentTaskStatus
  objective: string
  taskContext: Readonly<Record<string, unknown>>
  targetPolicy: Readonly<Record<string, unknown>>
  channel: Channel
  maxTargets: number
  maxAttemptsPerTarget: number
  budgetPolicy: Readonly<Record<string, unknown>>
  scheduledAt: string | null
  startedAt: string | null
  completedAt: string | null
  idempotencyKey: string
  correlationId: string
  createdBy: Uuid | null
  createdAt: string
}

export interface AgentTaskAllowedTool {
  key: string
  version: number
}

export interface AgentTaskFollowupPolicy {
  maxFollowups: number
  minimumIntervalMinutes: number
  maximumIntervalMinutes: number
  stopOnReply: boolean
  stopOnOptOut: boolean
  stopOnBusinessOutcome: boolean
}

/**
 * Completion/message policies are selected by stable keys and interpreted by
 * domain-owned runtime bindings in later phases. The generic task kernel only
 * stores and routes these contracts; it never branches on their business
 * meaning.
 */
export interface AgentTaskPolicyReference {
  key: string
  config: Readonly<Record<string, unknown>>
}

export interface AgentTaskTypeManifest {
  /** Stable task identity, e.g. coverage.sourcing. */
  key: string
  version: number
  /** Business-domain owner, e.g. coverage. */
  domain: string
  title: string
  description: string
  requiredAgentCapabilities: readonly string[]
  allowedChannels: readonly Channel[]
  /** Stable resolver binding key owned by the same domain. */
  targetResolver: string
  /** Exact platform tool versions the task may make available to its agent. */
  allowedTools: readonly AgentTaskAllowedTool[]
  requiredTaskApproval: AgentTaskApprovalMode
  followupPolicy: AgentTaskFollowupPolicy
  maxTargets: number
  completionPolicy: AgentTaskPolicyReference
  messagePolicy: AgentTaskPolicyReference
}

export interface AgentTaskContractIssue {
  code: string
  message: string
}

const DOMAIN_RE = /^[a-z][a-z0-9_]*$/
const TASK_KEY_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/
const CAPABILITY_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates]
}

export function validateAgentTaskTypeManifest(
  manifest: AgentTaskTypeManifest,
): AgentTaskContractIssue[] {
  const issues: AgentTaskContractIssue[] = []
  const add = (code: string, message: string) => issues.push({ code, message })

  if (!TASK_KEY_RE.test(manifest.key)) {
    add('INVALID_TASK_KEY', 'Task key must be a stable dotted lowercase identifier.')
  }
  if (!DOMAIN_RE.test(manifest.domain)) {
    add('INVALID_DOMAIN_KEY', 'Task domain must be a stable lowercase identifier.')
  }
  if (manifest.key.split('.')[0] !== manifest.domain) {
    add(
      'TASK_DOMAIN_MISMATCH',
      `Task ${manifest.key} must be owned by its key namespace ${manifest.domain}.`,
    )
  }
  if (!Number.isInteger(manifest.version) || manifest.version < 1) {
    add('INVALID_TASK_VERSION', 'Task version must be a positive integer.')
  }
  if (!manifest.title.trim() || !manifest.description.trim()) {
    add('MISSING_TASK_DESCRIPTION', 'Task title and description are required.')
  }

  for (const capability of manifest.requiredAgentCapabilities) {
    if (!CAPABILITY_RE.test(capability)) {
      add('INVALID_AGENT_CAPABILITY', `Invalid agent capability: ${capability}`)
    }
  }
  const duplicateCapabilities = duplicateValues(manifest.requiredAgentCapabilities)
  if (duplicateCapabilities.length > 0) {
    add(
      'DUPLICATE_AGENT_CAPABILITY',
      'Duplicate agent capabilities: ' + duplicateCapabilities.join(', '),
    )
  }

  if (manifest.allowedChannels.length === 0) {
    add('CHANNEL_REQUIRED', 'At least one allowed channel is required.')
  }
  const duplicateChannels = duplicateValues(manifest.allowedChannels)
  if (duplicateChannels.length > 0) {
    add('DUPLICATE_CHANNEL', 'Duplicate channels: ' + duplicateChannels.join(', '))
  }

  if (!TASK_KEY_RE.test(manifest.targetResolver)) {
    add(
      'INVALID_TARGET_RESOLVER',
      'Target resolver must be a stable dotted lowercase identifier.',
    )
  } else if (manifest.targetResolver.split('.')[0] !== manifest.domain) {
    add(
      'TARGET_RESOLVER_DOMAIN_MISMATCH',
      'Target resolver must be owned by the same business domain as the task.',
    )
  }

  const toolIds: string[] = []
  for (const tool of manifest.allowedTools) {
    if (!TASK_KEY_RE.test(tool.key)) {
      add('INVALID_ALLOWED_TOOL_KEY', `Invalid allowed tool key: ${tool.key}`)
    }
    if (!Number.isInteger(tool.version) || tool.version < 1) {
      add(
        'INVALID_ALLOWED_TOOL_VERSION',
        `Tool ${tool.key} must use a positive exact version.`,
      )
    }
    toolIds.push(`${tool.key}@${tool.version}`)
  }
  const duplicateTools = duplicateValues(toolIds)
  if (duplicateTools.length > 0) {
    add('DUPLICATE_ALLOWED_TOOL', 'Duplicate allowed tools: ' + duplicateTools.join(', '))
  }

  if (!Number.isInteger(manifest.maxTargets) || manifest.maxTargets < 1) {
    add('INVALID_MAX_TARGETS', 'maxTargets must be a positive integer.')
  }

  const followup = manifest.followupPolicy
  if (!Number.isInteger(followup.maxFollowups) || followup.maxFollowups < 0) {
    add('INVALID_MAX_FOLLOWUPS', 'maxFollowups must be a non-negative integer.')
  }
  if (
    !Number.isInteger(followup.minimumIntervalMinutes) ||
    followup.minimumIntervalMinutes < 0 ||
    !Number.isInteger(followup.maximumIntervalMinutes) ||
    followup.maximumIntervalMinutes < followup.minimumIntervalMinutes
  ) {
    add(
      'INVALID_FOLLOWUP_INTERVAL',
      'Follow-up intervals must be non-negative integers and maximum must be >= minimum.',
    )
  }

  for (const [name, policy] of [
    ['completionPolicy', manifest.completionPolicy],
    ['messagePolicy', manifest.messagePolicy],
  ] as const) {
    if (!TASK_KEY_RE.test(policy.key)) {
      add(
        'INVALID_POLICY_KEY',
        `${name} must use a stable dotted lowercase policy key.`,
      )
    } else if (policy.key.split('.')[0] !== manifest.domain) {
      add(
        'POLICY_DOMAIN_MISMATCH',
        `${name} must be owned by the same business domain as the task.`,
      )
    }
  }

  return issues
}

export function assertValidAgentTaskTypeManifest<T extends AgentTaskTypeManifest>(
  manifest: T,
): T {
  const issues = validateAgentTaskTypeManifest(manifest)
  if (issues.length > 0) {
    throw new Error(
      `Invalid agent task type ${manifest.key}@${manifest.version}: ` +
        issues.map((issue) => `${issue.code}: ${issue.message}`).join('; '),
    )
  }
  return manifest
}

export function defineAgentTaskType<T extends AgentTaskTypeManifest>(manifest: T): T {
  return assertValidAgentTaskTypeManifest(manifest)
}
