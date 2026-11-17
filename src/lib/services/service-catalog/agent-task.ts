import type { SupabaseClient } from '@supabase/supabase-js'
import { defineAgentTaskType } from '@/lib/ai/tasks/contracts'
import type { AgentTaskCompletionPolicy } from '@/lib/ai/tasks/completion-policy'
import type {
  AgentTaskModule,
  AgentTaskTargetCandidate,
  AgentTaskTargetResolver,
} from '@/lib/ai/tasks/target-resolution'
import type {
  AgentTaskOutboundMessageCandidate,
  AgentTaskOutboundMessagePolicy,
} from '@/lib/ai/tasks/outbound-policy'
import {
  assertTenantPromotionContacts,
  normalizeServicePromotionTagIds,
  parseFrozenServicePromotionContactIds,
  resolveServicePromotionAudience,
  MAX_SERVICE_PROMOTION_RECIPIENTS,
} from './promotion-audience'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const SERVICE_PROMOTION_TASK_TYPE = defineAgentTaskType({
  key: 'services.promotion',
  version: 1,
  domain: 'services',
  title: 'Service promotion',
  description:
    'Promote one active service to a frozen, deterministic tagged audience and continue replies through the same Agent Task.',
  requiredAgentCapabilities: ['services.promotion'],
  allowedChannels: ['whatsapp'],
  targetResolver: 'services.promotion_audience',
  allowedTools: [
    { key: 'services.get', version: 1 },
    { key: 'services.match_request', version: 1 },
    { key: 'intents.record', version: 1 },
  ],
  requiredTaskApproval: 'task',
  followupPolicy: {
    maxFollowups: 1,
    minimumIntervalMinutes: 1440,
    maximumIntervalMinutes: 10080,
    stopOnReply: true,
    stopOnOptOut: true,
    stopOnBusinessOutcome: true,
  },
  maxTargets: 100,
  completionPolicy: {
    key: 'services.promotion_completion',
    version: 1,
    config: { completionRule: 'all_targets_terminal' },
  },
  messagePolicy: {
    key: 'services.promotion_message',
    version: 1,
    config: {
      templateName: 'service_promotion_v1',
      templateLanguage: 'ar',
    },
  },
})

interface ServiceSnapshot {
  serviceId: string
  name: string
  code: string
  publicDescription: string | null
}

export async function loadServicePromotionContext(
  db: SupabaseClient,
  input: { accountId: string; serviceId: string },
): Promise<{ serviceId: string; service: ServiceSnapshot }> {
  if (!UUID_RE.test(input.serviceId)) {
    throw new Error('SERVICE_PROMOTION_SERVICE_ID_REQUIRED')
  }

  const { data: service, error } = await db
    .from('services')
    .select('id, name, code, status, current_revision_id')
    .eq('account_id', input.accountId)
    .eq('id', input.serviceId)
    .maybeSingle()
  if (error) throw error
  if (!service) throw new Error('SERVICE_PROMOTION_SERVICE_NOT_FOUND')
  if (service.status !== 'active') {
    throw new Error('SERVICE_PROMOTION_SERVICE_NOT_ACTIVE')
  }

  let publicDescription: string | null = null
  if (service.current_revision_id) {
    const { data: revision, error: revisionError } = await db
      .from('service_revisions')
      .select('public_description')
      .eq('account_id', input.accountId)
      .eq('id', service.current_revision_id)
      .maybeSingle()
    if (revisionError) throw revisionError
    publicDescription =
      typeof revision?.public_description === 'string'
        ? revision.public_description
        : null
  }

  return {
    serviceId: service.id,
    service: {
      serviceId: service.id,
      name: service.name,
      code: service.code,
      publicDescription,
    },
  }
}

export const SERVICE_PROMOTION_AUDIENCE_RESOLVER: AgentTaskTargetResolver = {
  key: 'services.promotion_audience',
  version: 1,
  domain: 'services',

  async resolve(db, context): Promise<readonly AgentTaskTargetCandidate[]> {
    const frozen = context.targetPolicy.frozenContactIds
    let contactIds: string[]
    if (frozen !== undefined) {
      // The immutable approved cohort is authoritative, even when tags later
      // change. SQL materialization independently rechecks eligibility and
      // suppression; never replace a removed contact with an unapproved one.
      contactIds = parseFrozenServicePromotionContactIds(frozen)
      await assertTenantPromotionContacts(db, context.accountId, contactIds)
    } else {
      // Legacy tasks without a snapshot fail closed on excess membership.
      // Do not derive a truncated LIMIT-based cohort for older tasks.
      const requiredTags = normalizeServicePromotionTagIds(
        context.targetPolicy.requiredTagIds, true,
      )
      const excludedTags = normalizeServicePromotionTagIds(
        context.targetPolicy.excludedTagIds ?? [], false,
      )
      contactIds = await resolveServicePromotionAudience(db, {
        accountId: context.accountId,
        requiredTagIds: requiredTags,
        excludedTagIds: excludedTags,
        maxContacts: Math.min(context.maxCandidates, MAX_SERVICE_PROMOTION_RECIPIENTS),
      })
    }

    return contactIds.map((contactId, index) => ({
      contactId,
      counterpartyRole: 'service_customer',
      sortKey: String(index).padStart(3, '0') + ':' + contactId,
    }))
  },
}

function policyString(
  config: Readonly<Record<string, unknown>>,
  key: string,
  fallback: string,
): string {
  const value = config[key]
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

export const SERVICE_PROMOTION_MESSAGE_POLICY: AgentTaskOutboundMessagePolicy = {
  key: 'services.promotion_message',
  version: 1,
  domain: 'services',
  generation: 'deterministic',

  async prepare(context): Promise<AgentTaskOutboundMessageCandidate> {
    if (
      context.taskType !== SERVICE_PROMOTION_TASK_TYPE.key ||
      context.counterpartyRole !== 'service_customer'
    ) {
      throw new Error('SERVICE_PROMOTION_MESSAGE_CONTEXT_INVALID')
    }
    const service = context.taskContext.service
    if (!service || typeof service !== 'object' || Array.isArray(service)) {
      throw new Error('SERVICE_PROMOTION_SERVICE_SNAPSHOT_REQUIRED')
    }
    const name = (service as Record<string, unknown>).name
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('SERVICE_PROMOTION_SERVICE_SNAPSHOT_INVALID')
    }

    return {
      kind: 'template',
      templateName: policyString(
        context.policy.config,
        'templateName',
        'service_promotion_v1',
      ),
      language: policyString(
        context.policy.config,
        'templateLanguage',
        'ar',
      ),
      params: [name.trim()],
    }
  },
}

const ACTIONABLE = new Set([
  'candidate',
  'eligible',
  'queued',
  'preparing',
  'sending',
  'contacted',
  'awaiting_reply',
  'replied',
  'in_progress',
])

export const SERVICE_PROMOTION_COMPLETION_POLICY: AgentTaskCompletionPolicy = {
  key: 'services.promotion_completion',
  version: 1,
  domain: 'services',

  async evaluate(db, context) {
    const { data: targets, error } = await db
      .from('ai_agent_task_targets')
      .select('status')
      .eq('account_id', context.accountId)
      .eq('task_id', context.taskId)
    if (error) throw error

    const statuses = (targets ?? []).map((row) => String(row.status))
    if (statuses.some((status) => ACTIONABLE.has(status))) {
      return {
        status: 'continue',
        reason: 'promotion_targets_still_actionable',
        payload: { actionableTargets: statuses.filter((s) => ACTIONABLE.has(s)).length },
      }
    }

    if (statuses.length === 0) {
      return {
        status: 'partially_completed',
        reason: 'promotion_segment_empty',
        payload: { targetCount: 0 },
      }
    }

    return {
      status: 'completed',
      reason: 'promotion_targets_terminal',
      payload: {
        targetCount: statuses.length,
        completedTargets: statuses.filter((s) => s === 'completed').length,
        optedOutTargets: statuses.filter((s) => s === 'opted_out').length,
        humanTargets: statuses.filter((s) => s === 'paused_for_human').length,
      },
    }
  },
}

export const SERVICE_PROMOTION_TASK_MODULE: AgentTaskModule = {
  domain: 'services',
  taskTypes: [SERVICE_PROMOTION_TASK_TYPE],
  targetResolvers: [SERVICE_PROMOTION_AUDIENCE_RESOLVER],
  outboundMessagePolicies: [SERVICE_PROMOTION_MESSAGE_POLICY],
  completionPolicies: [SERVICE_PROMOTION_COMPLETION_POLICY],
}
