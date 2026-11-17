import { randomUUID } from 'node:crypto'
import { supabaseAdmin } from '../admin-client'
import { CURRENT_AGENT_TASK_TRIGGER_REGISTRY } from './current-platform'
import { normalizeAgentTaskTriggerFiring } from './triggers'

export interface AgentTaskTriggerWorkerResult {
  materialized: {
    schedules: number
    businessEvents: number
  }
  claimed: number
  completed: number
  skipped: number
  deferred: number
  failed: number
  dead: number
}

export function normalizeAgentTaskTriggerWorkerLimit(limit?: number): number {
  if (limit === undefined) return 20
  if (!Number.isFinite(limit)) return 1
  return Math.max(1, Math.min(Math.trunc(limit), 100))
}

export async function processAgentTaskTriggerQueue(input: {
  workerId: string
  limit?: number
}): Promise<AgentTaskTriggerWorkerResult> {
  if (!input.workerId.trim()) {
    throw new Error('AGENT_TASK_TRIGGER_WORKER_ID_REQUIRED')
  }

  const db = supabaseAdmin()
  const limit = normalizeAgentTaskTriggerWorkerLimit(input.limit)
  const materialize = await db.rpc('materialize_agent_task_trigger_firings', {
    p_now: new Date().toISOString(),
    p_limit: Math.min(limit * 4, 500),
  })
  if (materialize.error) throw materialize.error

  const materialized = normalizeMaterialized(materialize.data)
  let claimed = 0
  let completed = 0
  let skipped = 0
  let deferred = 0
  let failed = 0
  let dead = 0

  for (let index = 0; index < limit; index += 1) {
    // Request a unique worker ID, then finalize only with the DB-issued
    // generation owner; old leases cannot finalize a reclaimed firing.
    const claimWorkerId = `${input.workerId.trim()}:${randomUUID()}`
    const claim = await db.rpc('claim_next_agent_task_trigger_firing', {
      p_worker_id: claimWorkerId,
      p_lease_secs: 120,
    })
    if (claim.error) throw claim.error
    if (!claim.data) break

    const claimOwner = (claim.data as { claim_owner?: unknown }).claim_owner
    if (
      typeof claimOwner !== 'string' ||
      !claimOwner.startsWith(`${claimWorkerId}:`)
    ) {
      throw new Error('AGENT_TASK_TRIGGER_DB_CLAIM_OWNER_REQUIRED')
    }
    const firing = normalizeAgentTaskTriggerFiring(claim.data)
    if (!firing) {
      throw new Error('AGENT_TASK_TRIGGER_FIRING_INVALID')
    }
    claimed += 1

    const handler = CURRENT_AGENT_TASK_TRIGGER_REGISTRY.get(
      firing.taskType,
      firing.taskTypeVersion,
    )
    if (!handler) {
      const outcome = await failFiring({
        firingId: firing.firingId,
        workerId: claimOwner,
        error:
          'AGENT_TASK_TRIGGER_HANDLER_NOT_REGISTERED:' +
          firing.taskType +
          '@' +
          firing.taskTypeVersion,
        delaySeconds: 300,
      })
      if (outcome === 'dead') dead += 1
      else failed += 1
      continue
    }

    try {
      const started = await handler.start(firing)
      if (started.created === false) {
        // A reused Task is not a newly created task. Verify whether its
        // original source is this exact firing before classifying an overlap.
        const { data: existing, error: lookupError } = await db
          .from('ai_agent_tasks')
          .select('trigger_ref')
          .eq('account_id', firing.accountId)
          .eq('id', started.taskId)
          .maybeSingle()
        if (lookupError) throw lookupError
        if (!existing) throw new Error('AGENT_TASK_TRIGGER_REUSED_TASK_NOT_FOUND')
        const expectedRef = firing.triggerKind === 'schedule'
          ? 'schedule:' + firing.triggerId + ':' + firing.sourceKey
          : 'business_event:' + firing.businessEvent?.id
        if (existing.trigger_ref !== expectedRef) {
          const settled = await settleOverlap(firing, claimOwner, 'OVERLAP_REUSED_ACTIVE_TASK')
          if (settled === 'skipped') skipped += 1
          else deferred += 1
          continue
        }
      }
      const complete = await db.rpc('complete_agent_task_trigger_firing', {
        p_firing_id: firing.firingId,
        p_worker_id: claimOwner,
        p_task_id: started.taskId,
      })
      if (complete.error) throw complete.error
      if (complete.data !== true) {
        throw new Error('AGENT_TASK_TRIGGER_FIRING_CLAIM_LOST')
      }
      completed += 1
    } catch (error) {
      const overlap = overlapErrorCode(error)
      if (overlap) {
        const settled = await settleOverlap(firing, claimOwner, overlap)
        if (settled === 'skipped') skipped += 1
        else deferred += 1
        continue
      }
      const outcome = await failFiring({
        firingId: firing.firingId,
        workerId: claimOwner,
        error: describeError(error),
        delaySeconds: 60,
      })
      if (outcome === 'dead') dead += 1
      else failed += 1
    }
  }

  return {
    materialized,
    claimed,
    completed,
    skipped,
    deferred,
    failed,
    dead,
  }
}

async function failFiring(input: {
  firingId: string
  workerId: string
  error: string
  delaySeconds: number
}): Promise<'failed' | 'dead'> {
  const { data, error } = await supabaseAdmin().rpc(
    'fail_agent_task_trigger_firing',
    {
      p_firing_id: input.firingId,
      p_worker_id: input.workerId,
      p_error: input.error.slice(0, 1000),
      p_delay_secs: input.delaySeconds,
    },
  )
  if (error) throw error
  // Null means the owner lost its lease or another worker already settled it.
  // Never report a successful 'failed' transition that did not happen in SQL.
  if (data !== 'dead' && data !== 'failed') {
    throw new Error('AGENT_TASK_TRIGGER_FIRING_CLAIM_LOST')
  }
  return data
}

function normalizeMaterialized(raw: unknown): {
  schedules: number
  businessEvents: number
} {
  const value =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  return {
    schedules: Math.max(0, Number(value.schedule_firings ?? 0) || 0),
    businessEvents: Math.max(
      0,
      Number(value.business_event_firings ?? 0) || 0,
    ),
  }
}

/** Failure audit is durable; never persist arbitrary handler exception text.
 * Unexpected errors may contain customer numbers, tokens or provider payloads.
 * Only typed system identifiers are eligible for DB persistence.
 */
function describeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown }
    for (const value of [candidate.code, candidate.message]) {
      if (typeof value === 'string' &&
        /^(?:AGENT_TASK|SCHEDULE|COVERAGE_SOURCING|SERVICE_PROMOTION)_[A-Z0-9_]{3,96}$/.test(value)) {
        return value
      }
    }
  }
  return 'AGENT_TASK_TRIGGER_HANDLER_ERROR'
}

/** Explicit domain overlap is a policy outcome, not a technical error. */
function overlapErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  const code = (error as { code: unknown }).code
  if (
    code === 'COVERAGE_SOURCING_ALREADY_ACTIVE' ||
    code === 'COVERAGE_SOURCING_CONNECTION_CHANGE_REQUIRES_TASK_EDIT' ||
    code === 'COVERAGE_SOURCING_TARGET_CHANGE_REQUIRES_PENDING_EDIT' ||
    code === 'SERVICE_PROMOTION_ALREADY_ACTIVE'
  ) return code
  return null
}

async function settleOverlap(
  firing: { firingId: string; overlapPolicy: 'skip' | 'defer' },
  claimOwner: string,
  reason: string,
): Promise<'skipped' | 'deferred'> {
  const skip = firing.overlapPolicy !== 'defer'
  const { data, error } = await supabaseAdmin().rpc(
    skip ? 'skip_agent_task_trigger_firing' : 'defer_agent_task_trigger_firing',
    skip
      ? { p_firing_id: firing.firingId, p_worker_id: claimOwner, p_reason: reason }
      : { p_firing_id: firing.firingId, p_worker_id: claimOwner, p_reason: reason, p_delay_secs: 300 },
  )
  if (error) throw error
  if (data !== true) throw new Error('AGENT_TASK_TRIGGER_FIRING_CLAIM_LOST')
  return skip ? 'skipped' : 'deferred'
}
