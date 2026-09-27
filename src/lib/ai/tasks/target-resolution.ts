import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '../admin-client'
import type { AgentTaskTypeManifest } from './contracts'
import { AgentTaskTypeRegistry } from './registry'
import {
  AgentTaskOutboundPolicyRegistry,
  type AgentTaskOutboundMessagePolicy,
} from './outbound-policy'

export interface AgentTaskTargetCandidate {
  contactId: string
  counterpartyRole: string
  /**
   * Domain-owned deterministic ordering key. The kernel never scores contacts
   * with an LLM and never invents candidates outside this resolver output.
   */
  sortKey: string
}

export interface AgentTaskTargetResolverContext {
  accountId: string
  taskId: string
  taskType: string
  taskTypeVersion: number
  taskContext: Readonly<Record<string, unknown>>
  targetPolicy: Readonly<Record<string, unknown>>
  maxCandidates: number
}

export interface AgentTaskTargetResolver {
  key: string
  version: number
  domain: string
  resolve(
    db: SupabaseClient,
    context: AgentTaskTargetResolverContext,
  ): Promise<readonly AgentTaskTargetCandidate[]>
}

export interface AgentTaskEligibilityPolicy {
  requiredTagIds: readonly string[]
  excludedTagIds: readonly string[]
  maxNewContactsPerHour: number
  maxContactsPerAgentPerDay: number
  cooldownMinutes: number
}

export interface TargetMaterializationDecision {
  contactId: string
  accepted: boolean
  reason: string
  targetId: string | null
  conversationId: string | null
}

export interface TargetMaterializationResult {
  status: 'resolved' | 'task_not_found' | 'task_type_not_registered'
  resolverKey: string | null
  considered: number
  accepted: number
  decisions: readonly TargetMaterializationDecision[]
}

export interface AgentTaskModule {
  domain: string
  taskTypes: readonly AgentTaskTypeManifest[]
  targetResolvers: readonly AgentTaskTargetResolver[]
  outboundMessagePolicies: readonly AgentTaskOutboundMessagePolicy[]
}

const KEY_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class AgentTaskTargetResolverRegistry {
  private readonly resolvers = new Map<string, AgentTaskTargetResolver>()

  register(domainOwner: string, resolver: AgentTaskTargetResolver): this {
    if (!KEY_RE.test(resolver.key)) {
      throw new Error(`Invalid target resolver key: ${resolver.key}`)
    }
    if (!Number.isInteger(resolver.version) || resolver.version < 1) {
      throw new Error(`Invalid target resolver version: ${resolver.key}`)
    }
    if (resolver.domain !== domainOwner) {
      throw new Error(
        `Target resolver domain ownership mismatch: ${resolver.key} belongs to ${resolver.domain}, registered by ${domainOwner}.`,
      )
    }
    if (resolver.key.split('.')[0] !== resolver.domain) {
      throw new Error(
        `Target resolver ${resolver.key} must use its domain namespace ${resolver.domain}.`,
      )
    }
    if (this.resolvers.has(resolver.key)) {
      throw new Error(`Duplicate target resolver: ${resolver.key}`)
    }
    this.resolvers.set(resolver.key, Object.freeze({ ...resolver }))
    return this
  }

  get(key: string): AgentTaskTargetResolver | null {
    return this.resolvers.get(key) ?? null
  }

  list(): readonly AgentTaskTargetResolver[] {
    return [...this.resolvers.values()]
  }
}

export function buildAgentTaskPlatform(modules: readonly AgentTaskModule[]): {
  taskTypes: AgentTaskTypeRegistry
  targetResolvers: AgentTaskTargetResolverRegistry
  outboundMessagePolicies: AgentTaskOutboundPolicyRegistry
} {
  const taskTypes = new AgentTaskTypeRegistry()
  const targetResolvers = new AgentTaskTargetResolverRegistry()
  const outboundMessagePolicies = new AgentTaskOutboundPolicyRegistry()

  for (const taskModule of modules) {
    for (const taskType of taskModule.taskTypes) {
      taskTypes.register(taskModule.domain, taskType)
    }
    for (const resolver of taskModule.targetResolvers) {
      targetResolvers.register(taskModule.domain, resolver)
    }
    for (const policy of taskModule.outboundMessagePolicies) {
      outboundMessagePolicies.register(taskModule.domain, policy)
    }
  }

  for (const taskType of taskTypes.list()) {
    const resolver = targetResolvers.get(taskType.targetResolver)
    if (!resolver) {
      throw new Error(
        `Task type ${taskType.key}@${taskType.version} references unregistered target resolver ${taskType.targetResolver}.`,
      )
    }
    if (resolver.domain !== taskType.domain) {
      throw new Error(
        `Task type ${taskType.key}@${taskType.version} cannot bind cross-domain resolver ${resolver.key}.`,
      )
    }

    const outboundPolicy = outboundMessagePolicies.get(taskType.messagePolicy.key)
    if (!outboundPolicy) {
      throw new Error(
        `Task type ${taskType.key}@${taskType.version} references unregistered outbound message policy ${taskType.messagePolicy.key}.`,
      )
    }
    if (outboundPolicy.domain !== taskType.domain) {
      throw new Error(
        `Task type ${taskType.key}@${taskType.version} cannot bind cross-domain outbound policy ${outboundPolicy.key}.`,
      )
    }
  }

  return { taskTypes, targetResolvers, outboundMessagePolicies }
}

export function parseAgentTaskEligibilityPolicy(
  raw: unknown,
): AgentTaskEligibilityPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('TARGET_ELIGIBILITY_POLICY_REQUIRED')
  }

  const value = raw as Record<string, unknown>
  const requiredTagIds = parseUuidArray(value.requiredTagIds, 'requiredTagIds')
  const excludedTagIds = parseUuidArray(value.excludedTagIds, 'excludedTagIds')
  const maxNewContactsPerHour = parseInteger(
    value.maxNewContactsPerHour,
    'maxNewContactsPerHour',
    1,
    10_000,
  )
  const maxContactsPerAgentPerDay = parseInteger(
    value.maxContactsPerAgentPerDay,
    'maxContactsPerAgentPerDay',
    1,
    100_000,
  )
  const cooldownMinutes = parseInteger(
    value.cooldownMinutes,
    'cooldownMinutes',
    0,
    525_600,
  )

  const excluded = new Set(excludedTagIds)
  if (requiredTagIds.some((id) => excluded.has(id))) {
    throw new Error('TARGET_ELIGIBILITY_TAG_FILTER_CONFLICT')
  }

  return {
    requiredTagIds,
    excludedTagIds,
    maxNewContactsPerHour,
    maxContactsPerAgentPerDay,
    cooldownMinutes,
  }
}

export async function materializeRegisteredTaskTargets(input: {
  taskId: string
  taskTypes: AgentTaskTypeRegistry
  targetResolvers: AgentTaskTargetResolverRegistry
  candidateLimit?: number
}): Promise<TargetMaterializationResult> {
  const db = supabaseAdmin()
  const { data: task, error } = await db
    .from('ai_agent_tasks')
    .select(
      'id, account_id, task_type, task_type_version, task_context, target_policy, max_targets, status',
    )
    .eq('id', input.taskId)
    .maybeSingle()

  if (error) throw error
  if (!task) {
    return {
      status: 'task_not_found',
      resolverKey: null,
      considered: 0,
      accepted: 0,
      decisions: [],
    }
  }

  const row = task as {
    id: string
    account_id: string
    task_type: string
    task_type_version: number
    task_context: Record<string, unknown> | null
    target_policy: Record<string, unknown> | null
    max_targets: number
    status: string
  }

  const manifest = input.taskTypes.get(row.task_type, row.task_type_version)
  if (!manifest) {
    return {
      status: 'task_type_not_registered',
      resolverKey: null,
      considered: 0,
      accepted: 0,
      decisions: [],
    }
  }

  const resolver = input.targetResolvers.get(manifest.targetResolver)
  if (!resolver || resolver.domain !== manifest.domain) {
    throw new Error(
      `TARGET_RESOLVER_NOT_REGISTERED:${manifest.targetResolver}`,
    )
  }

  const policy = parseAgentTaskEligibilityPolicy(row.target_policy ?? {})
  const candidateLimit = Math.max(
    1,
    Math.min(
      input.candidateLimit ?? Math.max(row.max_targets * 4, row.max_targets),
      1000,
    ),
  )

  const candidates = await resolver.resolve(db, {
    accountId: row.account_id,
    taskId: row.id,
    taskType: row.task_type,
    taskTypeVersion: row.task_type_version,
    taskContext: Object.freeze({ ...(row.task_context ?? {}) }),
    targetPolicy: Object.freeze({ ...(row.target_policy ?? {}) }),
    maxCandidates: candidateLimit,
  })

  const ordered = dedupeAndOrderCandidates(candidates).slice(0, candidateLimit)
  const decisions: TargetMaterializationDecision[] = []
  let accepted = 0

  for (const candidate of ordered) {
    if (accepted >= row.max_targets) break

    const idempotencyKey =
      `task:${row.id}:contact:${candidate.contactId}:resolver:` +
      `${resolver.key}@${resolver.version}`

    const { data, error: materializeError } = await db.rpc(
      'materialize_agent_task_contact_target',
      {
        p_task_id: row.id,
        p_contact_id: candidate.contactId,
        p_counterparty_role: candidate.counterpartyRole,
        p_resolver_key: resolver.key,
        p_resolver_version: resolver.version,
        p_required_tag_ids: [...policy.requiredTagIds],
        p_excluded_tag_ids: [...policy.excludedTagIds],
        p_max_new_contacts_per_hour: policy.maxNewContactsPerHour,
        p_max_contacts_per_agent_per_day: policy.maxContactsPerAgentPerDay,
        p_cooldown_minutes: policy.cooldownMinutes,
        p_idempotency_key: idempotencyKey,
      },
    )
    if (materializeError) throw materializeError

    const decision = normalizeDecision(candidate.contactId, data)
    decisions.push(decision)
    if (decision.accepted) accepted += 1
  }

  return {
    status: 'resolved',
    resolverKey: resolver.key,
    considered: decisions.length,
    accepted,
    decisions,
  }
}

function dedupeAndOrderCandidates(
  candidates: readonly AgentTaskTargetCandidate[],
): AgentTaskTargetCandidate[] {
  const sorted = [...candidates].sort(
    (a, b) =>
      a.sortKey.localeCompare(b.sortKey) ||
      a.contactId.localeCompare(b.contactId),
  )

  const seen = new Set<string>()
  const deduped: AgentTaskTargetCandidate[] = []
  for (const candidate of sorted) {
    if (!UUID_RE.test(candidate.contactId)) {
      throw new Error(`TARGET_RESOLVER_INVALID_CONTACT_ID:${candidate.contactId}`)
    }
    if (!candidate.counterpartyRole.trim()) {
      throw new Error('TARGET_RESOLVER_COUNTERPARTY_ROLE_REQUIRED')
    }
    if (seen.has(candidate.contactId)) continue
    seen.add(candidate.contactId)
    deduped.push(candidate)
  }
  return deduped
}

function normalizeDecision(
  contactId: string,
  raw: unknown,
): TargetMaterializationDecision {
  const value =
    raw && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : {}

  return {
    contactId,
    accepted: value.accepted === true,
    reason:
      typeof value.reason === 'string' && value.reason
        ? value.reason
        : 'unknown',
    targetId:
      typeof value.target_id === 'string' ? value.target_id : null,
    conversationId:
      typeof value.conversation_id === 'string'
        ? value.conversation_id
        : null,
  }
}

function parseUuidArray(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`TARGET_ELIGIBILITY_${field.toUpperCase()}_INVALID`)
  }

  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || !UUID_RE.test(item)) {
      throw new Error(`TARGET_ELIGIBILITY_${field.toUpperCase()}_INVALID`)
    }
    if (!seen.has(item)) {
      seen.add(item)
      out.push(item)
    }
  }
  return out
}

function parseInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`TARGET_ELIGIBILITY_${field.toUpperCase()}_INVALID`)
  }
  return value
}
