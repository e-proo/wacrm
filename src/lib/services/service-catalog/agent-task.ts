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

function parseRequiredTags(
  targetPolicy: Readonly<Record<string, unknown>>,
): string[] {
  const raw = targetPolicy.requiredTagIds
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > 100 ||
    raw.some((value) => typeof value !== 'string' || !UUID_RE.test(value))
  ) {
    throw new Error('SERVICE_PROMOTION_FROZEN_SEGMENT_REQUIRED')
  }
  return [...new Set(raw as string[])].sort()
}

export const SERVICE_PROMOTION_AUDIENCE_RESOLVER: AgentTaskTargetResolver = {
  key: 'services.promotion_audience',
  version: 1,
  domain: 'services',

  async resolve(db, context): Promise<readonly AgentTaskTargetCandidate[]> {
    const requiredTags = parseRequiredTags(context.targetPolicy)

    // A promotion may never scan the whole contacts table. Candidate discovery
    // starts from the explicit frozen tag segment and requires every selected
    // tag before the generic eligibility boundary evaluates suppression,
    // cooldown, channel availability, caps, and duplicates.
    const { data, error } = await db
      .from('contact_tags')
      .select('contact_id, tag_id')
      .in('tag_id', requiredTags)
      .limit(Math.min(context.maxCandidates * requiredTags.length * 4, 4000))
    if (error) throw error

    const matched = new Map<string, Set<string>>()
    for (const row of data ?? []) {
      const contactId = String(row.contact_id ?? '')
      const tagId = String(row.tag_id ?? '')
      if (!UUID_RE.test(contactId) || !requiredTags.includes(tagId)) continue
      const tags = matched.get(contactId) ?? new Set<string>()
      tags.add(tagId)
      matched.set(contactId, tags)
    }

    return [...matched.entries()]
      .filter(([, tags]) => tags.size === requiredTags.length)
      .map(([contactId]) => ({
        contactId,
        counterpartyRole: 'service_customer',
        sortKey: contactId,
      }))
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
      .slice(0, context.maxCandidates)
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
