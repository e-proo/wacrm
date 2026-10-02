import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadAccountRuntimePolicy } from '@/lib/ai/runtime/runtime-policy'
import {
  isAgentBuilderV2Configuration,
  validateBuilderV2Configuration,
  type AgentBuilderTaskBinding,
} from '@/lib/ai/tasks/builder-v2'
import {
  authorizeAgentRevisionForTask,
  loadAgentRevisionCapabilities,
  loadAgentRevisionToolGrants,
} from '@/lib/ai/tasks/capability-policy'
import type { AgentTaskStartSource } from '@/lib/ai/tasks/triggers'
import {
  COVERAGE_SOURCING_TASK_TYPE,
  loadCoverageSourcingTaskContext,
} from './agent-task'

const ACTIVE_TASK_STATUSES = [
  'validating',
  'scheduled',
  'queued',
  'running',
  'paused',
] as const

const REQUIRED_COVERAGE_SOURCING_TOOLS = new Set([
  'coverage.get_rates@1',
  'coverage.propose_offer@2',
])

export class CoverageSourcingTaskError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'CoverageSourcingTaskError'
    this.code = code
    this.status = status
  }
}

export interface StartCoverageSourcingTaskInput {
  accountId: string
  coverageRequestId: string
  agentId: string
  actorUserId: string | null
  trigger?: AgentTaskStartSource
}

export interface StartCoverageSourcingTaskResult {
  taskId: string
  agentId: string
  revisionId: string
  created: boolean
}

function findCoverageBinding(
  bindings: readonly AgentBuilderTaskBinding[],
): AgentBuilderTaskBinding | null {
  return (
    bindings.find(
      (binding) =>
        binding.taskType === COVERAGE_SOURCING_TASK_TYPE.key &&
        binding.taskTypeVersion === COVERAGE_SOURCING_TASK_TYPE.version,
    ) ?? null
  )
}

function taskIdempotencyKey(input: {
  coverageRequestId: string
  agentId: string
  revisionId: string
  sourceKey?: string | null
}): string {
  const base =
    'coverage:sourcing:request:' +
    input.coverageRequestId +
    ':agent:' +
    input.agentId +
    ':revision:' +
    input.revisionId
  return input.sourceKey ? base + ':source:' + input.sourceKey : base
}

export async function startCoverageSourcingTask(
  input: StartCoverageSourcingTaskInput,
): Promise<StartCoverageSourcingTaskResult> {
  const db = supabaseAdmin()

  const runtimePolicy = await loadAccountRuntimePolicy(db, input.accountId)
  if (
    runtimePolicy.killSwitch ||
    !runtimePolicy.multiAgentEnabled ||
    !runtimePolicy.recoveryWorkerEnabled ||
    !runtimePolicy.nativeToolsEnabled ||
    !runtimePolicy.proposalToolsEnabled ||
    !runtimePolicy.outboundTaskDeliveryEnabled
  ) {
    throw new CoverageSourcingTaskError(
      'COVERAGE_SOURCING_RUNTIME_NOT_READY',
      'The account AI runtime is not enabled for live durable proposal-based Agent Tasks.',
    )
  }

  const requestContext = await loadCoverageSourcingTaskContext(db, {
    accountId: input.accountId,
    coverageRequestId: input.coverageRequestId,
  })

  const { data: existingTask, error: existingError } = await db
    .from('ai_agent_tasks')
    .select('id, agent_id, agent_revision_id')
    .eq('account_id', input.accountId)
    .eq('task_type', COVERAGE_SOURCING_TASK_TYPE.key)
    .eq('task_type_version', COVERAGE_SOURCING_TASK_TYPE.version)
    .in('status', [...ACTIVE_TASK_STATUSES])
    .contains('task_context', {
      coverageRequestId: input.coverageRequestId,
    })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existingError) throw existingError

  if (existingTask) {
    const row = existingTask as {
      id: string
      agent_id: string
      agent_revision_id: string
    }
    if (row.agent_id !== input.agentId) {
      throw new CoverageSourcingTaskError(
        'COVERAGE_SOURCING_ALREADY_ACTIVE',
        'This Coverage Request already has an active sourcing task assigned to another agent.',
      )
    }
    return {
      taskId: row.id,
      agentId: row.agent_id,
      revisionId: row.agent_revision_id,
      created: false,
    }
  }

  const { data: agent, error: agentError } = await db
    .from('ai_agents')
    .select('id, status, published_revision_id')
    .eq('account_id', input.accountId)
    .eq('id', input.agentId)
    .maybeSingle()
  if (agentError) throw agentError
  if (!agent) {
    throw new CoverageSourcingTaskError(
      'COVERAGE_SOURCING_AGENT_NOT_FOUND',
      'Agent not found in this account.',
      404,
    )
  }

  const agentRow = agent as {
    id: string
    status: string
    published_revision_id: string | null
  }
  if (agentRow.status !== 'active' || !agentRow.published_revision_id) {
    throw new CoverageSourcingTaskError(
      'COVERAGE_SOURCING_AGENT_NOT_ACTIVE',
      'Coverage sourcing requires an active agent with a published revision.',
    )
  }

  const revisionId = agentRow.published_revision_id
  const { data: revision, error: revisionError } = await db
    .from('ai_agent_revisions')
    .select(
      'id, status, operational_mode, outreach_policy, max_tool_rounds',
    )
    .eq('account_id', input.accountId)
    .eq('agent_id', input.agentId)
    .eq('id', revisionId)
    .maybeSingle()
  if (revisionError) throw revisionError
  if (!revision || revision.status !== 'published') {
    throw new CoverageSourcingTaskError(
      'COVERAGE_SOURCING_REVISION_NOT_PUBLISHED',
      'The selected agent does not have an executable published revision.',
    )
  }
  if (Number(revision.max_tool_rounds ?? 0) < 1) {
    throw new CoverageSourcingTaskError(
      'COVERAGE_SOURCING_TOOL_ROUNDS_DISABLED',
      'The selected agent must allow at least one tool round for supplier replies.',
    )
  }

  const rawPolicy =
    revision.outreach_policy &&
    typeof revision.outreach_policy === 'object' &&
    !Array.isArray(revision.outreach_policy)
      ? (revision.outreach_policy as Record<string, unknown>)
      : {}
  const configCandidate = {
    operationalMode: revision.operational_mode,
    bindings: rawPolicy.bindings,
  }
  if (!isAgentBuilderV2Configuration(configCandidate)) {
    throw new CoverageSourcingTaskError(
      'COVERAGE_SOURCING_BUILDER_INVALID',
      'The published agent revision does not contain a valid Builder V2 configuration.',
    )
  }

  const [revisionCapabilities, revisionToolGrants] = await Promise.all([
    loadAgentRevisionCapabilities(db, {
      accountId: input.accountId,
      revisionId,
    }),
    loadAgentRevisionToolGrants(db, {
      accountId: input.accountId,
      revisionId,
    }),
  ])

  const { CURRENT_AGENT_TASK_PLATFORM } = await import(
    '@/lib/ai/tasks/current-platform'
  )
  const builderValidation = validateBuilderV2Configuration({
    config: configCandidate,
    registry: CURRENT_AGENT_TASK_PLATFORM.taskTypes,
    revisionToolGrants,
  })
  if (!builderValidation.ok) {
    throw new CoverageSourcingTaskError(
      'COVERAGE_SOURCING_BUILDER_INVALID',
      builderValidation.issues.map((issue) => issue.message).join('; '),
    )
  }

  const binding = findCoverageBinding(configCandidate.bindings)
  if (!binding) {
    throw new CoverageSourcingTaskError(
      'COVERAGE_SOURCING_BINDING_MISSING',
      'The selected published agent revision is not configured for Coverage sourcing.',
    )
  }

  if (
    binding.targetScope.serviceIds.length > 0 &&
    !binding.targetScope.serviceIds.includes(requestContext.request.serviceId)
  ) {
    throw new CoverageSourcingTaskError(
      'COVERAGE_SOURCING_SERVICE_SCOPE_DENIED',
      'The Coverage Request service is outside the agent Builder service scope.',
    )
  }

  if (binding.targetScope.domainSelector !== null) {
    throw new CoverageSourcingTaskError(
      'COVERAGE_SOURCING_SELECTOR_UNSUPPORTED',
      'This Coverage sourcing Task Type does not support an additional domain selector yet.',
    )
  }

  const manifest = CURRENT_AGENT_TASK_PLATFORM.taskTypes.get(
    COVERAGE_SOURCING_TASK_TYPE.key,
    COVERAGE_SOURCING_TASK_TYPE.version,
  )
  if (!manifest) {
    throw new CoverageSourcingTaskError(
      'COVERAGE_SOURCING_TASK_TYPE_NOT_REGISTERED',
      'Coverage sourcing is not registered in the current Agent Task Platform.',
      500,
    )
  }

  const authorization = authorizeAgentRevisionForTask({
    manifest,
    revisionCapabilities,
    revisionToolGrants,
  })
  if (!authorization.ok) {
    throw new CoverageSourcingTaskError(
      authorization.code,
      authorization.message,
    )
  }

  const effectiveToolIds = new Set(
    authorization.allowedTools.map(
      (tool) => `${tool.key}@${tool.version}`,
    ),
  )
  const missingRequiredTools = [...REQUIRED_COVERAGE_SOURCING_TOOLS].filter(
    (toolId) => !effectiveToolIds.has(toolId),
  )
  if (missingRequiredTools.length > 0) {
    throw new CoverageSourcingTaskError(
      'COVERAGE_SOURCING_REQUIRED_TOOLS_MISSING',
      'The published revision is missing required Coverage sourcing tool grants: ' +
        missingRequiredTools.join(', '),
    )
  }

  const taskContext = {
    coverageRequestId: input.coverageRequestId,
    request: {
      ...requestContext.request,
      attributes: { ...requestContext.request.attributes },
    },
  }
  const targetPolicy = {
    requiredTagIds: [...binding.targetScope.requiredTagIds],
    excludedTagIds: [...binding.targetScope.excludedTagIds],
    maxNewContactsPerHour: binding.maxNewContactsPerHour,
    maxContactsPerAgentPerDay: binding.maxContactsPerAgentPerDay,
    cooldownMinutes: binding.cooldownMinutes,
    coverageRegionIds: [...binding.targetScope.regionIds],
  }
  const budgetPolicy = {
    source: 'agent_builder_v2',
    approvalMode: binding.approvalMode,
    maxFollowups: binding.maxFollowups,
    workingHours: {
      ...binding.workingHours,
      weekdays: [...binding.workingHours.weekdays],
    },
    dailyMessageBudget: binding.dailyMessageBudget,
    dailyTokenBudget: binding.dailyTokenBudget,
  }

  const idempotencyKey = taskIdempotencyKey({
    coverageRequestId: input.coverageRequestId,
    agentId: input.agentId,
    revisionId,
    sourceKey: input.trigger?.sourceKey,
  })
  const correlationId =
    'coverage:sourcing:' +
    input.coverageRequestId +
    ':' +
    revisionId +
    (input.trigger ? ':source:' + input.trigger.sourceKey : '')

  const { data: taskId, error: createError } = await db.rpc(
    'create_ai_agent_task',
    {
      p_account_id: input.accountId,
      p_task_type: COVERAGE_SOURCING_TASK_TYPE.key,
      p_task_type_version: COVERAGE_SOURCING_TASK_TYPE.version,
      p_agent_id: input.agentId,
      p_agent_revision_id: revisionId,
      p_trigger_type: input.trigger?.triggerType ?? 'manual',
      p_trigger_ref:
        input.trigger?.triggerRef ??
        'coverage_request:' + input.coverageRequestId,
      p_objective:
        'Source compatible coverage capacity for the frozen Coverage Request.',
      p_task_context: taskContext,
      p_target_policy: targetPolicy,
      p_channel: 'whatsapp',
      p_max_targets: binding.maxTargets,
      p_max_attempts_per_target: binding.maxAttemptsPerTarget,
      p_budget_policy: budgetPolicy,
      p_scheduled_at: null,
      p_idempotency_key: idempotencyKey,
      p_correlation_id: correlationId,
      p_created_by: input.actorUserId,
    },
  )
  if (createError) throw createError
  if (typeof taskId !== 'string' || !taskId) {
    throw new CoverageSourcingTaskError(
      'COVERAGE_SOURCING_TASK_CREATE_FAILED',
      'The Coverage sourcing task could not be created.',
      500,
    )
  }

  return {
    taskId,
    agentId: input.agentId,
    revisionId,
    created: true,
  }
}
