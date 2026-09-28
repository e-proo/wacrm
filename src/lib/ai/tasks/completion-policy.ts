import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentTaskTypeRegistry } from './registry'

export type AgentTaskCompletionStatus =
  | 'continue'
  | 'completed'
  | 'partially_completed'
  | 'failed'
  | 'cancelled'

export interface AgentTaskCompletionDecision {
  status: AgentTaskCompletionStatus
  reason: string
  payload?: Readonly<Record<string, unknown>>
}

export interface AgentTaskCompletionPolicyContext {
  accountId: string
  taskId: string
  taskType: string
  taskTypeVersion: number
  taskContext: Readonly<Record<string, unknown>>
  targetPolicy: Readonly<Record<string, unknown>>
}

export interface AgentTaskCompletionPolicy {
  key: string
  version: number
  domain: string
  evaluate(
    db: SupabaseClient,
    context: AgentTaskCompletionPolicyContext,
  ): Promise<AgentTaskCompletionDecision>
}

const KEY_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/

export class AgentTaskCompletionPolicyRegistry {
  private readonly policies = new Map<string, AgentTaskCompletionPolicy>()

  register(domainOwner: string, policy: AgentTaskCompletionPolicy): this {
    if (!KEY_RE.test(policy.key)) {
      throw new Error(`Invalid completion policy key: ${policy.key}`)
    }
    if (!Number.isInteger(policy.version) || policy.version < 1) {
      throw new Error(
        `Invalid completion policy version: ${policy.key}`,
      )
    }
    if (policy.domain !== domainOwner) {
      throw new Error(
        `Completion policy domain ownership mismatch: ${policy.key} belongs to ${policy.domain}, registered by ${domainOwner}.`,
      )
    }
    if (policy.key.split('.')[0] !== policy.domain) {
      throw new Error(
        `Completion policy ${policy.key} must use its domain namespace ${policy.domain}.`,
      )
    }

    const id = `${policy.key}@${policy.version}`
    if (this.policies.has(id)) {
      throw new Error(`Duplicate completion policy: ${id}`)
    }

    this.policies.set(id, Object.freeze({ ...policy }))
    return this
  }

  get(key: string, version: number): AgentTaskCompletionPolicy | null {
    return this.policies.get(`${key}@${version}`) ?? null
  }

  list(): readonly AgentTaskCompletionPolicy[] {
    return [...this.policies.values()]
  }
}

export async function evaluateRegisteredTaskCompletion(input: {
  db: SupabaseClient
  taskId: string
  taskTypes: AgentTaskTypeRegistry
  completionPolicies: AgentTaskCompletionPolicyRegistry
}): Promise<AgentTaskCompletionDecision & { finalized: boolean }> {
  const { data: task, error } = await input.db
    .from('ai_agent_tasks')
    .select(
      'id, account_id, task_type, task_type_version, task_context, target_policy, status',
    )
    .eq('id', input.taskId)
    .maybeSingle()
  if (error) throw error

  if (!task) {
    return {
      status: 'continue',
      reason: 'task_not_found',
      finalized: false,
    }
  }

  const row = task as {
    id: string
    account_id: string
    task_type: string
    task_type_version: number
    task_context: Record<string, unknown> | null
    target_policy: Record<string, unknown> | null
    status: string
  }

  if (row.status !== 'running') {
    return {
      status: 'continue',
      reason: 'task_not_running',
      finalized: false,
    }
  }

  const manifest = input.taskTypes.get(
    row.task_type,
    row.task_type_version,
  )
  if (!manifest) {
    return {
      status: 'continue',
      reason: 'task_type_not_registered',
      finalized: false,
    }
  }

  const policy = input.completionPolicies.get(
    manifest.completionPolicy.key,
    manifest.completionPolicy.version,
  )
  if (!policy || policy.domain !== manifest.domain) {
    throw new Error(
      `TASK_COMPLETION_POLICY_NOT_REGISTERED:${manifest.completionPolicy.key}@${manifest.completionPolicy.version}`,
    )
  }

  const decision = await policy.evaluate(input.db, {
    accountId: row.account_id,
    taskId: row.id,
    taskType: row.task_type,
    taskTypeVersion: row.task_type_version,
    taskContext: Object.freeze({ ...(row.task_context ?? {}) }),
    targetPolicy: Object.freeze({ ...(row.target_policy ?? {}) }),
  })

  if (decision.status === 'continue') {
    return { ...decision, finalized: false }
  }

  const { data: finalized, error: finalizationError } = await input.db.rpc(
    'finalize_agent_task_by_policy',
    {
      p_task_id: row.id,
      p_terminal_status: decision.status,
      p_policy_key: policy.key,
      p_policy_version: policy.version,
      p_reason: decision.reason,
      p_payload: decision.payload ?? {},
    },
  )
  if (finalizationError) throw finalizationError

  return {
    ...decision,
    finalized: finalized === true,
  }
}
