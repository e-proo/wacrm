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
  failed: number
  dead: number
}

export function normalizeAgentTaskTriggerWorkerLimit(limit?: number): number {
  return Math.max(1, Math.min(limit ?? 20, 100))
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
  let failed = 0
  let dead = 0

  for (let index = 0; index < limit; index += 1) {
    const claim = await db.rpc('claim_next_agent_task_trigger_firing', {
      p_worker_id: input.workerId,
      p_lease_secs: 120,
    })
    if (claim.error) throw claim.error
    if (!claim.data) break

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
        workerId: input.workerId,
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
      const complete = await db.rpc('complete_agent_task_trigger_firing', {
        p_firing_id: firing.firingId,
        p_worker_id: input.workerId,
        p_task_id: started.taskId,
      })
      if (complete.error) throw complete.error
      if (complete.data !== true) {
        throw new Error('AGENT_TASK_TRIGGER_FIRING_CLAIM_LOST')
      }
      completed += 1
    } catch (error) {
      const outcome = await failFiring({
        firingId: firing.firingId,
        workerId: input.workerId,
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
  return data === 'dead' ? 'dead' : 'failed'
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

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return String(error || 'AGENT_TASK_TRIGGER_FAILED')
}
