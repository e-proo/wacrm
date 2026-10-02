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
  SERVICE_PROMOTION_TASK_TYPE,
  loadServicePromotionContext,
} from './agent-task'

const ACTIVE_TASK_STATUSES = [
  'validating',
  'scheduled',
  'queued',
  'running',
  'paused',
] as const

const REQUIRED_TOOLS = new Set([
  'services.get@1',
  'services.match_request@1',
  'intents.record@1',
])

export class ServicePromotionTaskError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'ServicePromotionTaskError'
    this.code = code
    this.status = status
  }
}

function findBinding(
  bindings: readonly AgentBuilderTaskBinding[],
): AgentBuilderTaskBinding | null {
  return (
    bindings.find(
      (binding) =>
        binding.taskType === SERVICE_PROMOTION_TASK_TYPE.key &&
        binding.taskTypeVersion === SERVICE_PROMOTION_TASK_TYPE.version,
    ) ?? null
  )
}

export async function startServicePromotionTask(input: {
  accountId: string
  serviceId: string
  agentId: string
  actorUserId: string | null
  trigger?: AgentTaskStartSource
}): Promise<{
  taskId: string
  agentId: string
  revisionId: string
  created: boolean
}> {
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
    throw new ServicePromotionTaskError(
      'SERVICE_PROMOTION_RUNTIME_NOT_READY',
      'The account AI runtime is not enabled for durable proposal-based Agent Tasks.',
    )
  }

  const promotionContext = await loadServicePromotionContext(db, {
    accountId: input.accountId,
    serviceId: input.serviceId,
  })

  const { data: existing, error: existingError } = await db
    .from('ai_agent_tasks')
    .select('id, agent_id, agent_revision_id')
    .eq('account_id', input.accountId)
    .eq('task_type', SERVICE_PROMOTION_TASK_TYPE.key)
    .eq('task_type_version', SERVICE_PROMOTION_TASK_TYPE.version)
    .in('status', [...ACTIVE_TASK_STATUSES])
    .contains('task_context', { serviceId: input.serviceId })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existingError) throw existingError
  if (existing) {
    if (existing.agent_id !== input.agentId) {
      throw new ServicePromotionTaskError(
        'SERVICE_PROMOTION_ALREADY_ACTIVE',
        'This service already has an active promotion task assigned to another agent.',
      )
    }
    return {
      taskId: existing.id,
      agentId: existing.agent_id,
      revisionId: existing.agent_revision_id,
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
    throw new ServicePromotionTaskError(
      'SERVICE_PROMOTION_AGENT_NOT_FOUND',
      'Agent not found in this account.',
      404,
    )
  }
  if (agent.status !== 'active' || !agent.published_revision_id) {
    throw new ServicePromotionTaskError(
      'SERVICE_PROMOTION_AGENT_NOT_ACTIVE',
      'Service promotion requires an active agent with a published revision.',
    )
  }

  const revisionId = agent.published_revision_id
  const { data: revision, error: revisionError } = await db
    .from('ai_agent_revisions')
    .select('id, status, operational_mode, outreach_policy, max_tool_rounds')
    .eq('account_id', input.accountId)
    .eq('agent_id', input.agentId)
    .eq('id', revisionId)
    .maybeSingle()
  if (revisionError) throw revisionError
  if (!revision || revision.status !== 'published') {
    throw new ServicePromotionTaskError(
      'SERVICE_PROMOTION_REVISION_NOT_PUBLISHED',
      'The selected agent does not have an executable published revision.',
    )
  }
  if (Number(revision.max_tool_rounds ?? 0) < 1) {
    throw new ServicePromotionTaskError(
      'SERVICE_PROMOTION_TOOL_ROUNDS_DISABLED',
      'The selected agent must allow at least one tool round for customer replies.',
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
    throw new ServicePromotionTaskError(
      'SERVICE_PROMOTION_BUILDER_INVALID',
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
  const validation = validateBuilderV2Configuration({
    config: configCandidate,
    registry: CURRENT_AGENT_TASK_PLATFORM.taskTypes,
    revisionToolGrants,
  })
  if (!validation.ok) {
    throw new ServicePromotionTaskError(
      'SERVICE_PROMOTION_BUILDER_INVALID',
      validation.issues.map((issue) => issue.message).join('; '),
    )
  }

  const binding = findBinding(configCandidate.bindings)
  if (!binding) {
    throw new ServicePromotionTaskError(
      'SERVICE_PROMOTION_BINDING_MISSING',
      'The published revision is not configured for Service promotion.',
    )
  }
  if (
    binding.targetScope.serviceIds.length > 0 &&
    !binding.targetScope.serviceIds.includes(input.serviceId)
  ) {
    throw new ServicePromotionTaskError(
      'SERVICE_PROMOTION_SERVICE_SCOPE_DENIED',
      'The selected service is outside the agent Builder service scope.',
    )
  }
  if (binding.targetScope.requiredTagIds.length === 0) {
    throw new ServicePromotionTaskError(
      'SERVICE_PROMOTION_SEGMENT_REQUIRED',
      'Service promotion requires at least one explicit target tag; unbounded contact scanning is forbidden.',
    )
  }
  if (
    binding.targetScope.regionIds.length > 0 ||
    binding.targetScope.domainSelector !== null
  ) {
    throw new ServicePromotionTaskError(
      'SERVICE_PROMOTION_SELECTOR_UNSUPPORTED',
      'Service promotion V1 accepts frozen tag segments only.',
    )
  }

  const manifest = CURRENT_AGENT_TASK_PLATFORM.taskTypes.get(
    SERVICE_PROMOTION_TASK_TYPE.key,
    SERVICE_PROMOTION_TASK_TYPE.version,
  )
  if (!manifest) {
    throw new ServicePromotionTaskError(
      'SERVICE_PROMOTION_TASK_TYPE_NOT_REGISTERED',
      'Service promotion is not registered in the current Agent Task Platform.',
      500,
    )
  }
  const authorization = authorizeAgentRevisionForTask({
    manifest,
    revisionCapabilities,
    revisionToolGrants,
  })
  if (!authorization.ok) {
    throw new ServicePromotionTaskError(
      authorization.code,
      authorization.message,
    )
  }

  const effectiveToolIds = new Set(
    authorization.allowedTools.map((tool) => `${tool.key}@${tool.version}`),
  )
  const missing = [...REQUIRED_TOOLS].filter((id) => !effectiveToolIds.has(id))
  if (missing.length > 0) {
    throw new ServicePromotionTaskError(
      'SERVICE_PROMOTION_REQUIRED_TOOLS_MISSING',
      'The published revision is missing required Service promotion tool grants: ' +
        missing.join(', '),
    )
  }

  const frozenTags = [...binding.targetScope.requiredTagIds].sort()
  const taskContext = {
    serviceId: input.serviceId,
    service: { ...promotionContext.service },
    segmentSnapshot: {
      requiredTagIds: frozenTags,
      excludedTagIds: [...binding.targetScope.excludedTagIds].sort(),
    },
  }
  const targetPolicy = {
    requiredTagIds: frozenTags,
    excludedTagIds: [...binding.targetScope.excludedTagIds].sort(),
    maxNewContactsPerHour: binding.maxNewContactsPerHour,
    maxContactsPerAgentPerDay: binding.maxContactsPerAgentPerDay,
    cooldownMinutes: binding.cooldownMinutes,
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
  const segmentKey = frozenTags.join(',')
  const baseIdempotencyKey =
    `services:promotion:service:${input.serviceId}:segment:${segmentKey}:agent:${input.agentId}:revision:${revisionId}`
  const idempotencyKey = input.trigger
    ? baseIdempotencyKey + ':source:' + input.trigger.sourceKey
    : baseIdempotencyKey
  const correlationId =
    `services:promotion:${input.serviceId}:${revisionId}:${segmentKey}` +
    (input.trigger ? ':source:' + input.trigger.sourceKey : '')

  const { data: taskId, error: createError } = await db.rpc(
    'create_ai_agent_task',
    {
      p_account_id: input.accountId,
      p_task_type: SERVICE_PROMOTION_TASK_TYPE.key,
      p_task_type_version: SERVICE_PROMOTION_TASK_TYPE.version,
      p_agent_id: input.agentId,
      p_agent_revision_id: revisionId,
      p_trigger_type: input.trigger?.triggerType ?? 'manual',
      p_trigger_ref:
        input.trigger?.triggerRef ?? 'service:' + input.serviceId,
      p_objective:
        'Promote the frozen service snapshot to the explicit eligible customer segment and capture qualified customer intent.',
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
    throw new ServicePromotionTaskError(
      'SERVICE_PROMOTION_TASK_CREATE_FAILED',
      'The Service promotion task could not be created.',
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
