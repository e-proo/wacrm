import { supabaseAdmin } from '@/lib/ai/admin-client'
import { createHash } from 'node:crypto'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'
import { inspectServicePromotionCampaign, assertPromotionReviewFresh, ServicePromotionReviewError } from './promotion-campaign-review'
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
import { readFrozenPromotionSchedule, scheduledPromotionCampaignMatches, type PromotionScheduledReview } from './promotion-schedule-policy'
import {
  SERVICE_PROMOTION_TASK_TYPE,
  SERVICE_PROMOTION_TASK_TYPE_V2,
  loadServicePromotionContext,
} from './agent-task'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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
        binding.taskTypeVersion === SERVICE_PROMOTION_TASK_TYPE_V2.version,
    ) ?? null
  )
}

export async function startServicePromotionTask(input: {
  accountId: string
  serviceId: string
  agentId: string
  actorUserId: string | null
  trigger?: AgentTaskStartSource
  /** SCH-1: bind scheduled work to the reviewed published revision. */
  approvedRevisionId?: string | null
  review?: {
    connectionId: string
    fingerprint: string
    reviewedAt: string
    submissionId: string
    consentAcknowledged: boolean
    approvalAcknowledged: boolean
    /** DB-frozen reviewed schedule; not accepted from manual launches. */
    scheduledPolicy?: PromotionScheduledReview
  }
}): Promise<{
  taskId: string
  agentId: string
  revisionId: string
  created: boolean
}> {
  const reviewInput = input.review
  const scheduled = input.trigger !== undefined
  // Historical direct/manual launch remains unchanged. Scheduled V2 requires
  // the frozen review created by the privileged account-scoped scheduler API.
  if (!reviewInput || !UUID_RE.test(reviewInput.connectionId) ||
      !UUID_RE.test(reviewInput.submissionId) ||
      reviewInput.consentAcknowledged !== true ||
      reviewInput.approvalAcknowledged !== true ||
      (scheduled && (input.trigger?.triggerType !== 'scheduled' ||
        !input.approvedRevisionId ||
        !reviewInput.scheduledPolicy ||
        reviewInput.scheduledPolicy.connectionId !== reviewInput.connectionId)) ||
      (!scheduled && reviewInput.scheduledPolicy)) {
    throw new ServicePromotionTaskError(
      'SERVICE_PROMOTION_REVIEW_REQUIRED',
      'Manually review and approve a pinned Service Promotion V2 campaign before launch.',
      409,
    )
  }
  if (scheduled && input.trigger) {
    // Defense-in-depth: the service itself validates DB-frozen approval even
    // if invoked outside the registered scheduler handler.
    const approved = readFrozenPromotionSchedule({
      promotionReview: reviewInput?.scheduledPolicy,
    }, {
      serviceId: input.serviceId, agentId: input.agentId,
      approvedRevisionId: input.approvedRevisionId ?? null,
      createdBy: input.actorUserId,
    }, { allowExpiredForReconciliation: true })
    if (approved.fingerprint !== reviewInput?.fingerprint ||
        approved.reviewedAt !== reviewInput?.reviewedAt) {
      throw new ServicePromotionTaskError(
        'SERVICE_PROMOTION_SCHEDULE_REVIEW_SCOPE_CONFLICT',
        'A scheduled Task must use exactly the frozen reviewed campaign.')
    }
  }
  const db = supabaseAdmin()
  if (scheduled && input.trigger) {
    const identity = promotionScheduledTaskIdentity({
      accountId: input.accountId, serviceId: input.serviceId, agentId: input.agentId,
      revisionId: input.approvedRevisionId!, sourceKey: input.trigger.sourceKey,
    })
    // Retry after an ambiguous worker completion must return the *same* Task
    // without requiring a fresh preview or creating another audience/outbound.
    const { data: replay, error: replayError } = await db.from('ai_agent_tasks')
      .select('id,agent_id,agent_revision_id,trigger_ref,task_type_version')
      .eq('account_id', input.accountId)
      .eq('idempotency_key', identity).maybeSingle()
    if (replayError) throw replayError
    if (replay) {
      if (replay.agent_id !== input.agentId ||
        replay.agent_revision_id !== input.approvedRevisionId ||
        replay.trigger_ref !== input.trigger.triggerRef ||
        replay.task_type_version !== SERVICE_PROMOTION_TASK_TYPE_V2.version) {
        throw new ServicePromotionTaskError(
          'SERVICE_PROMOTION_SCHEDULE_REPLAY_SCOPE_CONFLICT',
          'A scheduled firing points to an incompatible existing Task.')
      }
      return { taskId: replay.id, agentId: replay.agent_id,
        revisionId: replay.agent_revision_id, created: false }
    }
  }
  // Creating a NEW promotion Task remains TEST-only and explicitly gated.
  // Existing matching Task reconciliation above is read-only and safe even
  // after the Pilot is paused, preventing ambiguous resend.
  if (!isOpenWATestProject() ||
      process.env.WACRM_SERVICE_PROMOTION_PILOT_ALLOW_LIVE !== '1') {
    throw new ServicePromotionTaskError(
      'SERVICE_PROMOTION_LIVE_ACCEPTANCE_NOT_AUTHORIZED',
      'Service Promotion dispatch is disabled until the bounded TEST pilot is approved.',
      403,
    )
  }
  if (scheduled) {
    // Reconciliation of an ALREADY-created Task is allowed after approval TTL,
    // but a new Task creation is not. No target scan occurs on the replay path.
    readFrozenPromotionSchedule({ promotionReview: reviewInput?.scheduledPolicy }, {
      serviceId: input.serviceId, agentId: input.agentId,
      approvedRevisionId: input.approvedRevisionId ?? null,
      createdBy: input.actorUserId,
    })
  }
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
  if (input.approvedRevisionId && input.approvedRevisionId !== revisionId) {
    throw new ServicePromotionTaskError(
      'SERVICE_PROMOTION_SCHEDULE_REVISION_CHANGED',
      'The published agent revision changed after this schedule was reviewed.',
    )
  }
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
      'Service promotion accepts frozen tag segments only.',
    )
  }

  const manifest = CURRENT_AGENT_TASK_PLATFORM.taskTypes.get(
    SERVICE_PROMOTION_TASK_TYPE.key,
    SERVICE_PROMOTION_TASK_TYPE_V2.version,
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

  // Re-evaluate the exact approved audience, service snapshot, published
  // revision, pinned provider, provider admission and Meta template. If any
  // relevant scope changes after preview, the operator must review again.
  let campaign
  try {
    campaign = await inspectServicePromotionCampaign(db, {
      accountId: input.accountId,
      serviceId: input.serviceId,
      agentId: input.agentId,
      connectionId: reviewInput.connectionId,
    })
    if (scheduled && reviewInput.scheduledPolicy) {
      const pinned = reviewInput.scheduledPolicy
      if (!scheduledPromotionCampaignMatches(pinned, campaign)) {
        throw new ServicePromotionReviewError('SERVICE_PROMOTION_SCHEDULE_REVIEW_STALE')
      }
    } else {
      assertPromotionReviewFresh({
        fingerprint: reviewInput.fingerprint,
        reviewedAt: reviewInput.reviewedAt,
        actualFingerprint: campaign.fingerprint,
      })
    }
  } catch (error) {
    if (error instanceof ServicePromotionReviewError) {
      throw new ServicePromotionTaskError(error.code, error.message, error.status)
    }
    throw error
  }
  if (campaign.blockers.length > 0 ||
      campaign.agent.revisionId !== revisionId ||
      campaign.binding.maxTargets !== binding.maxTargets) {
    throw new ServicePromotionTaskError(
      'SERVICE_PROMOTION_REVIEW_BLOCKED',
      'Review blocked: ' + [...campaign.blockers, 'revision_or_caps_changed']
        .filter(Boolean).join(', '),
    )
  }
  const frozenTags = [...binding.targetScope.requiredTagIds].sort()
  const excludedTags = [...binding.targetScope.excludedTagIds].sort()
  const frozenContactIds = [...campaign.audience.ids]
  if (frozenContactIds.length === 0) {
    throw new ServicePromotionTaskError('SERVICE_PROMOTION_AUDIENCE_EMPTY',
      'No eligible contacts are approved.', 409)
  }
  const campaignDigest = createHash('sha256').update(JSON.stringify({
    accountId: input.accountId, serviceId: input.serviceId, agentId: input.agentId,
    revisionId, connectionId: reviewInput.connectionId,
    submissionId: reviewInput.submissionId,
  })).digest('hex')
  const idempotencyKey = scheduled && input.trigger
    ? promotionScheduledTaskIdentity({
      accountId: input.accountId, serviceId: input.serviceId, agentId: input.agentId,
      revisionId, sourceKey: input.trigger.sourceKey,
    })
    : 'services:promotion:v2:' + campaignDigest
  const correlationId = scheduled ? idempotencyKey : 'services:promotion:v2:' + campaignDigest

  // Cross-version overlap: a previous V1 promotion must not silently share
  // its contacts or override the operator's new provider choice.
  const { data: existing, error: existingError } = await db
    .from('ai_agent_tasks')
    .select('id, agent_id, agent_revision_id, idempotency_key')
    .eq('account_id', input.accountId)
    .eq('task_type', SERVICE_PROMOTION_TASK_TYPE.key)
    .in('task_type_version', [1, 2])
    .in('status', [...ACTIVE_TASK_STATUSES])
    .contains('task_context', { serviceId: input.serviceId })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existingError) throw existingError
  if (existing) {
    if (existing.idempotency_key !== idempotencyKey ||
        existing.agent_id !== input.agentId ||
        existing.agent_revision_id !== revisionId) {
      throw new ServicePromotionTaskError('SERVICE_PROMOTION_ALREADY_ACTIVE',
        'A different campaign is already active for this service.')
    }
    return { taskId: existing.id, agentId: existing.agent_id,
      revisionId: existing.agent_revision_id, created: false }
  }

  const approvedAt = new Date().toISOString()
  const taskContext = {
    serviceId: input.serviceId,
    service: { ...promotionContext.service },
    segmentSnapshot: {
      requiredTagIds: frozenTags,
      excludedTagIds: excludedTags,
      frozenContactIds,
    },
    promotionApproval: {
      actorUserId: input.actorUserId,
      approvedAt,
      reviewedAt: reviewInput.reviewedAt,
      fingerprint: campaign.fingerprint,
      submissionId: reviewInput.submissionId,
      provider: campaign.connection.provider,
      connectionId: reviewInput.connectionId,
      consentBasis: 'operator_attestation',
      consentPlatformVerified: campaign.connection.provider === 'openwa',
      metaTemplateLocalStatus: campaign.template?.status ?? null,
    },
  }
  const targetPolicy = {
    requiredTagIds: frozenTags,
    excludedTagIds: excludedTags,
    frozenContactIds,
    whatsappConnectionId: reviewInput.connectionId,
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
  const { data: taskId, error: createError } = await db.rpc(
    'create_ai_agent_task',
    {
      p_account_id: input.accountId,
      p_task_type: SERVICE_PROMOTION_TASK_TYPE.key,
      p_task_type_version: SERVICE_PROMOTION_TASK_TYPE_V2.version,
      p_agent_id: input.agentId,
      p_agent_revision_id: revisionId,
      p_trigger_type: input.trigger?.triggerType ?? 'manual',
      p_trigger_ref: input.trigger?.triggerRef ?? 'service:' + input.serviceId,
      p_objective:
        'Promote the frozen service snapshot to the explicit eligible customer segment and capture qualified customer intent.',
      p_task_context: taskContext,
      p_target_policy: targetPolicy,
      p_channel: 'whatsapp',
      p_max_targets: frozenContactIds.length,
      p_max_attempts_per_target: binding.maxAttemptsPerTarget,
      p_budget_policy: budgetPolicy,
      p_scheduled_at: null,
      p_idempotency_key: idempotencyKey,
      p_correlation_id: correlationId,
      p_created_by: input.actorUserId,
    },
  )
  if (createError?.code === '23505') {
    // Covers the DB unique index when two administrators launch overlapping
    // campaigns concurrently, after both read the same "no active Task".
    throw new ServicePromotionTaskError(
      'SERVICE_PROMOTION_ALREADY_ACTIVE',
      'An overlapping campaign was created concurrently. Refresh its status before proceeding.',
      409,
    )
  }
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

/** Stable per occurrence and tenant: two workers / retry share one Task id. */
export function promotionScheduledTaskIdentity(input: {
  accountId: string; serviceId: string; agentId: string;
  revisionId: string; sourceKey: string
}): string {
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  return 'services:promotion:v2:schedule:' + digest
}
