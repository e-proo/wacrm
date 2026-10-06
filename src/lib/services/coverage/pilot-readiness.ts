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
  COVERAGE_SOURCING_TASK_TYPE,
  COVERAGE_SUPPLIER_CANDIDATE_RESOLVER,
  loadCoverageSourcingTaskContext,
} from './agent-task'

export interface CoverageSourcingPilotReadiness {
  readyForPublish: boolean
  readyForLive: boolean
  blockers: readonly string[]
  externalBlockers: readonly string[]
  candidateCount: number
  eligibleTestSupplierCount: number
  testSupplierTagId: string | null
  approvedTemplate: boolean
  revisionStatus: string
  cutoverMode: string
}

export async function inspectCoverageSourcingPilotReadiness(input: {
  accountId: string
  agentId: string
  revisionId: string
  coverageRequestId: string
}): Promise<CoverageSourcingPilotReadiness> {
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
      candidate.taskType === COVERAGE_SOURCING_TASK_TYPE.key &&
      candidate.taskTypeVersion === COVERAGE_SOURCING_TASK_TYPE.version,
  )
  if (config && !binding) blockers.push('COVERAGE_SOURCING_BINDING_MISSING')

  if (config && binding) {
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
      binding.maxTargets < 2 ||
      binding.maxTargets > 3 ||
      binding.maxNewContactsPerHour > 3 ||
      binding.maxContactsPerAgentPerDay > 3
    ) {
      blockers.push('PILOT_TARGET_LIMIT_NOT_2_TO_3')
    }
  }

  const testSupplierTagId =
    revision?.settings &&
    typeof revision.settings.phase19_test_supplier_tag_id === 'string'
      ? revision.settings.phase19_test_supplier_tag_id
      : null

  if (!testSupplierTagId) {
    blockers.push('PILOT_TEST_SUPPLIER_TAG_MISSING')
  } else if (
    binding &&
    !binding.targetScope.requiredTagIds.includes(testSupplierTagId)
  ) {
    blockers.push('PILOT_TEST_SUPPLIER_TAG_NOT_REQUIRED')
  }

  let taskContext: Awaited<
    ReturnType<typeof loadCoverageSourcingTaskContext>
  > | null = null
  try {
    taskContext = await loadCoverageSourcingTaskContext(db, {
      accountId: input.accountId,
      coverageRequestId: input.coverageRequestId,
    })
  } catch {
    blockers.push('COVERAGE_REQUEST_NOT_SOURCEABLE')
  }

  let candidateIds: string[] = []
  if (taskContext && binding) {
    const candidates = await COVERAGE_SUPPLIER_CANDIDATE_RESOLVER.resolve(
      db,
      {
        accountId: input.accountId,
        taskId: 'pilot-readiness',
        taskType: COVERAGE_SOURCING_TASK_TYPE.key,
        taskTypeVersion: COVERAGE_SOURCING_TASK_TYPE.version,
        taskContext: { ...taskContext },
        targetPolicy: {
          coverageRegionIds: [...binding.targetScope.regionIds],
        },
        maxCandidates: 20,
      },
    )
    candidateIds = [...new Set(candidates.map((candidate) => candidate.contactId))]
  }

  const eligibleTestSupplierCount =
    testSupplierTagId && candidateIds.length > 0
      ? await countEligibleTaggedCandidates({
          accountId: input.accountId,
          tagId: testSupplierTagId,
          candidateIds,
        })
      : 0

  if (eligibleTestSupplierCount < 2 || eligibleTestSupplierCount > 3) {
    externalBlockers.push('PILOT_REQUIRES_2_TO_3_TAGGED_MATCHING_SUPPLIERS')
  }

  const { count: approvedTemplateCount, error: templateError } = await db
    .from('message_templates')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', input.accountId)
    .eq('name', 'coverage_sourcing_supplier_v1')
    .eq('language', 'ar')
    .eq('status', 'APPROVED')
  if (templateError) throw templateError
  const approvedTemplate = (approvedTemplateCount ?? 0) > 0
  if (!approvedTemplate) {
    externalBlockers.push('COVERAGE_SOURCING_APPROVED_TEMPLATE_MISSING')
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
    eligibleTestSupplierCount,
    testSupplierTagId,
    approvedTemplate,
    revisionStatus: revision?.status ?? 'missing',
    cutoverMode: cutover.mode,
  }
}

async function countEligibleTaggedCandidates(input: {
  accountId: string
  tagId: string
  candidateIds: readonly string[]
}): Promise<number> {
  const db = supabaseAdmin()
  const [contactsRes, tagsRes, controlsRes] = await Promise.all([
    db
      .from('contacts')
      .select('id, phone_normalized')
      .eq('account_id', input.accountId)
      .in('id', [...input.candidateIds]),
    db
      .from('contact_tags')
      .select('contact_id')
      .eq('tag_id', input.tagId)
      .in('contact_id', [...input.candidateIds]),
    db
      .from('ai_outreach_contact_controls')
      .select('contact_id, state, suppressed_until')
      .eq('account_id', input.accountId)
      .eq('channel', 'whatsapp')
      .in('contact_id', [...input.candidateIds])
      .in('state', ['opted_out', 'blocked']),
  ])
  if (contactsRes.error) throw contactsRes.error
  if (tagsRes.error) throw tagsRes.error
  if (controlsRes.error) throw controlsRes.error

  const tagged = new Set(
    (tagsRes.data ?? []).map((row) => String(row.contact_id)),
  )
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
      tagged.has(String(row.id)) &&
      !suppressed.has(String(row.id)) &&
      /^[0-9]{8,15}$/.test(phone)
    )
  }).length
}
