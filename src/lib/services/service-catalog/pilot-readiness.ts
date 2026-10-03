import { supabaseAdmin } from '@/lib/ai/admin-client'
import { inspectAgentTaskTestCutoverReadiness } from '@/lib/ai/tasks/cutover'
import {
  isAgentBuilderV2Configuration,
  validateBuilderV2Configuration,
} from '@/lib/ai/tasks/builder-v2'
import {
  loadAgentRevisionCapabilities,
  loadAgentRevisionToolGrants,
} from '@/lib/ai/tasks/capability-policy'
import { CURRENT_AGENT_TASK_PLATFORM } from '@/lib/ai/tasks/current-platform'
import { validateAgentRevisionForPublish } from '@/lib/ai/runtime/builder-service'
import {
  SERVICE_PROMOTION_AUDIENCE_RESOLVER,
  SERVICE_PROMOTION_TASK_TYPE,
  loadServicePromotionContext,
} from './agent-task'

export interface ServicePromotionPilotReadiness {
  readyForPublish: boolean
  readyForLive: boolean
  blockers: readonly string[]
  externalBlockers: readonly string[]
  candidateCount: number
  eligibleTestContactCount: number
  testContactTagId: string | null
  approvedTemplate: boolean
  revisionStatus: string
  cutoverMode: string
}

export async function inspectServicePromotionPilotReadiness(input: {
  accountId: string
  agentId: string
  revisionId: string
  serviceId: string
}): Promise<ServicePromotionPilotReadiness> {
  const db = supabaseAdmin()
  const blockers: string[] = []
  const externalBlockers: string[] = []

  const [agentRes, revisionRes, grants, capabilities, cutover] =
    await Promise.all([
      db
        .from('ai_agents')
        .select('id, published_revision_id, status')
        .eq('account_id', input.accountId)
        .eq('id', input.agentId)
        .maybeSingle(),
      db
        .from('ai_agent_revisions')
        .select(
          'id, status, operational_mode, outreach_policy, settings',
        )
        .eq('account_id', input.accountId)
        .eq('agent_id', input.agentId)
        .eq('id', input.revisionId)
        .maybeSingle(),
      loadAgentRevisionToolGrants(db, {
        accountId: input.accountId,
        revisionId: input.revisionId,
      }),
      loadAgentRevisionCapabilities(db, {
        accountId: input.accountId,
        revisionId: input.revisionId,
      }),
      inspectAgentTaskTestCutoverReadiness({
        accountId: input.accountId,
      }),
    ])

  if (agentRes.error) throw agentRes.error
  if (revisionRes.error) throw revisionRes.error
  if (!agentRes.data) blockers.push('PILOT_AGENT_NOT_FOUND')
  if (!revisionRes.data) blockers.push('PILOT_REVISION_NOT_FOUND')

  const revision = revisionRes.data as {
    status: string
    operational_mode: string
    outreach_policy: Record<string, unknown> | null
    settings: Record<string, unknown> | null
  } | null

  const rawConfig = revision
    ? {
        operationalMode: revision.operational_mode,
        bindings:
          revision.outreach_policy &&
          typeof revision.outreach_policy === 'object' &&
          !Array.isArray(revision.outreach_policy)
            ? revision.outreach_policy.bindings
            : null,
      }
    : null

  const config =
    rawConfig && isAgentBuilderV2Configuration(rawConfig)
      ? rawConfig
      : null
  if (revision && !config) blockers.push('PILOT_BUILDER_CONFIG_INVALID')

  const binding = config?.bindings.find(
    (candidate) =>
      candidate.taskType === SERVICE_PROMOTION_TASK_TYPE.key &&
      candidate.taskTypeVersion === SERVICE_PROMOTION_TASK_TYPE.version,
  )
  if (config && !binding) blockers.push('SERVICE_PROMOTION_BINDING_MISSING')

  if (binding) {
    const validation = validateBuilderV2Configuration({
      config,
      registry: CURRENT_AGENT_TASK_PLATFORM.taskTypes,
      revisionToolGrants: grants,
    })
    if (!validation.ok) blockers.push('PILOT_BUILDER_VALIDATION_FAILED')

    const actual = new Set(capabilities)
    if (validation.capabilities.some((capability) => !actual.has(capability))) {
      blockers.push('PILOT_CAPABILITY_SET_INCOMPLETE')
    }

    if (
      binding.maxTargets < 1 ||
      binding.maxTargets > 3 ||
      binding.maxNewContactsPerHour > 3 ||
      binding.maxContactsPerAgentPerDay > 3
    ) {
      blockers.push('PILOT_CONTACT_LIMIT_NOT_SMALL')
    }

    if (!binding.targetScope.serviceIds.includes(input.serviceId)) {
      blockers.push('PILOT_SERVICE_NOT_FROZEN_IN_SCOPE')
    }
  }

  const testContactTagId =
    revision?.settings &&
    typeof revision.settings.phase20_test_contact_tag_id === 'string'
      ? revision.settings.phase20_test_contact_tag_id
      : null

  if (!testContactTagId) {
    blockers.push('PILOT_TEST_CONTACT_TAG_MISSING')
  } else if (
    binding &&
    !binding.targetScope.requiredTagIds.includes(testContactTagId)
  ) {
    blockers.push('PILOT_TEST_CONTACT_TAG_NOT_REQUIRED')
  }

  let serviceContext: Awaited<
    ReturnType<typeof loadServicePromotionContext>
  > | null = null
  try {
    serviceContext = await loadServicePromotionContext(db, {
      accountId: input.accountId,
      serviceId: input.serviceId,
    })
  } catch {
    blockers.push('SERVICE_PROMOTION_SERVICE_NOT_ACTIVE')
  }

  let candidateIds: string[] = []
  if (serviceContext && binding) {
    const candidates = await SERVICE_PROMOTION_AUDIENCE_RESOLVER.resolve(
      db,
      {
        accountId: input.accountId,
        taskId: 'pilot-readiness',
        taskType: SERVICE_PROMOTION_TASK_TYPE.key,
        taskTypeVersion: SERVICE_PROMOTION_TASK_TYPE.version,
        taskContext: serviceContext,
        targetPolicy: {
          requiredTagIds: [...binding.targetScope.requiredTagIds],
        },
        maxCandidates: 20,
      },
    )
    candidateIds = [...new Set(candidates.map((candidate) => candidate.contactId))]
  }

  const eligibleTestContactCount =
    candidateIds.length > 0
      ? await countEligibleCandidates(input.accountId, candidateIds)
      : 0

  if (eligibleTestContactCount < 1 || eligibleTestContactCount > 3) {
    externalBlockers.push('PILOT_REQUIRES_1_TO_3_ELIGIBLE_TEST_CONTACTS')
  }

  const { count: approvedTemplateCount, error: templateError } = await db
    .from('message_templates')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', input.accountId)
    .eq('name', 'service_promotion_v1')
    .eq('language', 'ar')
    .eq('status', 'APPROVED')
  if (templateError) throw templateError

  const approvedTemplate = (approvedTemplateCount ?? 0) > 0
  if (!approvedTemplate) {
    externalBlockers.push('SERVICE_PROMOTION_APPROVED_TEMPLATE_MISSING')
  }

  const publishedRevisionId =
    typeof agentRes.data?.published_revision_id === 'string'
      ? agentRes.data.published_revision_id
      : null
  const revisionIsPublished =
    revision?.status === 'published' &&
    publishedRevisionId === input.revisionId

  if (revision?.status === 'draft') {
    const publishValidation = await validateAgentRevisionForPublish(db, {
      accountId: input.accountId,
      agentId: input.agentId,
      revisionId: input.revisionId,
    })
    if (!publishValidation.ok) {
      blockers.push('PILOT_REVISION_PUBLISH_VALIDATION_FAILED')
    }
  } else if (!revisionIsPublished) {
    blockers.push('PILOT_REVISION_NOT_DRAFT_OR_CURRENT_PUBLISHED')
  }

  if (cutover.mode !== 'pilot') {
    externalBlockers.push('AGENT_TASK_CUTOVER_NOT_PILOT')
  }

  const readyForPublish =
    blockers.length === 0 &&
    revision?.status === 'draft' &&
    externalBlockers.every(
      (blocker) => blocker === 'AGENT_TASK_CUTOVER_NOT_PILOT',
    )

  const readyForLive =
    blockers.length === 0 &&
    externalBlockers.length === 0 &&
    revisionIsPublished

  return {
    readyForPublish,
    readyForLive,
    blockers: Object.freeze([...new Set(blockers)]),
    externalBlockers: Object.freeze([...new Set(externalBlockers)]),
    candidateCount: candidateIds.length,
    eligibleTestContactCount,
    testContactTagId,
    approvedTemplate,
    revisionStatus: revision?.status ?? 'missing',
    cutoverMode: cutover.mode,
  }
}

async function countEligibleCandidates(
  accountId: string,
  candidateIds: readonly string[],
): Promise<number> {
  const db = supabaseAdmin()
  const [contactsRes, controlsRes] = await Promise.all([
    db
      .from('contacts')
      .select('id, phone_normalized')
      .eq('account_id', accountId)
      .in('id', [...candidateIds]),
    db
      .from('ai_outreach_contact_controls')
      .select('contact_id, suppressed_until')
      .eq('account_id', accountId)
      .eq('channel', 'whatsapp')
      .in('contact_id', [...candidateIds])
      .in('state', ['opted_out', 'blocked']),
  ])
  if (contactsRes.error) throw contactsRes.error
  if (controlsRes.error) throw controlsRes.error

  const now = Date.now()
  const suppressed = new Set(
    (controlsRes.data ?? [])
      .filter((row) => {
        if (!row.suppressed_until) return true
        const until = Date.parse(String(row.suppressed_until))
        return !Number.isFinite(until) || until > now
      })
      .map((row) => String(row.contact_id)),
  )

  return (contactsRes.data ?? []).filter((row) => {
    const phone = String(row.phone_normalized ?? '')
    return (
      !suppressed.has(String(row.id)) &&
      /^[0-9]{8,15}$/.test(phone)
    )
  }).length
}
