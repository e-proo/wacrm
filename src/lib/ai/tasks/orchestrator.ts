import { supabaseAdmin } from '../admin-client'
import { loadAccountRuntimePolicy } from '../runtime/runtime-policy'

export interface AgentTaskSweepResult {
  tasksRecovered: number
  targetsRequeued: number
  targetsExhausted: number
}

export interface AgentTaskWorkerResult {
  swept: AgentTaskSweepResult
  scannedTasks: number
  claimedTasks: number
  claimedTargets: number
  createdRuns: number
  deferredTasks: number
  skippedByPolicy: number
  failed: number
}

export function normalizeAgentTaskWorkerLimit(limit?: number): number {
  return Math.max(1, Math.min(limit ?? 20, 100))
}

function normalizeSweep(raw: unknown): AgentTaskSweepResult {
  const value =
    raw && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : {}

  return {
    tasksRecovered: Number(value.tasks_recovered ?? 0) || 0,
    targetsRequeued: Number(value.targets_requeued ?? 0) || 0,
    targetsExhausted: Number(value.targets_exhausted ?? 0) || 0,
  }
}

function rpcErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'TASK_ORCHESTRATOR_ERROR'
  const value = error as { code?: unknown; message?: unknown }
  if (typeof value.code === 'string' && value.code.trim()) return value.code
  if (typeof value.message === 'string' && value.message.trim()) {
    const compact = value.message
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80)
    if (compact) return compact
  }
  return 'TASK_ORCHESTRATOR_ERROR'
}

/**
 * Durable recovery for task/target leases.
 *
 * Recovery lives in SQL so two worker processes can call this concurrently
 * without racing each other. The function itself uses row locks + SKIP LOCKED.
 */
export async function sweepAgentTaskClaims(
  now = new Date(),
): Promise<AgentTaskSweepResult> {
  const db = supabaseAdmin()
  const { data, error } = await db.rpc('sweep_agent_task_claims', {
    p_now: now.toISOString(),
  })
  if (error) throw error
  return normalizeSweep(data)
}

/**
 * One bounded Task Orchestrator tick.
 *
 * Phase 5 deliberately stops after durable outbound run creation:
 *
 * task -> target -> queued outbound ai_agent_run
 *
 * It does NOT call the model and does NOT send WhatsApp. Phase 7 owns
 * outbound-message policy/reservation/transport. Keeping that boundary here
 * prevents this worker from becoming a bypass around channel policy.
 */
export async function processAgentTaskQueue(input: {
  workerId: string
  limit?: number
}): Promise<AgentTaskWorkerResult> {
  if (!input.workerId.trim()) {
    throw new Error('TASK_ORCHESTRATOR_WORKER_ID_REQUIRED')
  }

  const db = supabaseAdmin()
  const limit = normalizeAgentTaskWorkerLimit(input.limit)
  const swept = await sweepAgentTaskClaims()

  let scannedTasks = 0
  let claimedTasks = 0
  let claimedTargets = 0
  let createdRuns = 0
  let deferredTasks = 0
  let skippedByPolicy = 0
  let failed = 0

  for (let i = 0; i < limit; i += 1) {
    scannedTasks += 1

    const taskClaim = await db.rpc('claim_next_agent_task', {
      p_worker_id: input.workerId,
      p_lease_secs: 120,
    })
    if (taskClaim.error) throw taskClaim.error

    const taskId =
      typeof taskClaim.data === 'string' && taskClaim.data
        ? taskClaim.data
        : null

    if (!taskId) break
    claimedTasks += 1

    const { data: task, error: taskError } = await db
      .from('ai_agent_tasks')
      .select('id, account_id, status')
      .eq('id', taskId)
      .maybeSingle()

    if (taskError || !task) {
      failed += 1
      await releaseTaskClaim(db, taskId, input.workerId, 30)
      continue
    }

    const row = task as {
      id: string
      account_id: string
      status: string
    }

    const policy = await loadAccountRuntimePolicy(db, row.account_id)
    if (
      !policy.recoveryWorkerEnabled ||
      policy.killSwitch ||
      !policy.multiAgentEnabled
    ) {
      skippedByPolicy += 1
      await releaseTaskClaim(db, taskId, input.workerId, 60)
      continue
    }

    const targetClaim = await db.rpc('claim_next_agent_task_target', {
      p_task_id: taskId,
      p_worker_id: input.workerId,
      p_lease_secs: 180,
    })
    if (targetClaim.error) {
      failed += 1
      await releaseTaskClaim(db, taskId, input.workerId, 30)
      continue
    }

    const targetId =
      typeof targetClaim.data === 'string' && targetClaim.data
        ? targetClaim.data
        : null

    if (!targetId) {
      deferredTasks += 1
      await releaseTaskClaim(db, taskId, input.workerId, 30)
      continue
    }

    claimedTargets += 1

    const createRun = await db.rpc('create_claimed_agent_task_execution', {
      p_task_id: taskId,
      p_task_target_id: targetId,
      p_worker_id: input.workerId,
    })

    if (createRun.error || typeof createRun.data !== 'string') {
      failed += 1

      const retry = await db.rpc('retry_agent_task_target_claim', {
        p_task_id: taskId,
        p_task_target_id: targetId,
        p_worker_id: input.workerId,
        p_error_code: rpcErrorCode(createRun.error),
        p_delay_secs: 60,
      })
      if (retry.error) {
        console.error(
          '[task orchestrator] target retry scheduling failed:',
          retry.error,
        )
      }

      await releaseTaskClaim(db, taskId, input.workerId, 30)
      continue
    }

    createdRuns += 1

    // A single task lease serializes target scheduling. Release it after one
    // target so another worker tick may fairly process the next due target.
    await releaseTaskClaim(db, taskId, input.workerId, 0)
  }

  return {
    swept,
    scannedTasks,
    claimedTasks,
    claimedTargets,
    createdRuns,
    deferredTasks,
    skippedByPolicy,
    failed,
  }
}

export async function pauseAgentTask(input: {
  accountId: string
  taskId: string
  actorId?: string
}): Promise<boolean> {
  const db = supabaseAdmin()
  const { data, error } = await db.rpc('pause_agent_task', {
    p_account_id: input.accountId,
    p_task_id: input.taskId,
    p_actor_id: input.actorId ?? 'task-orchestrator',
  })
  if (error) throw error
  return data === true
}

export async function resumeAgentTask(input: {
  accountId: string
  taskId: string
  actorId?: string
}): Promise<boolean> {
  const db = supabaseAdmin()
  const { data, error } = await db.rpc('resume_agent_task', {
    p_account_id: input.accountId,
    p_task_id: input.taskId,
    p_actor_id: input.actorId ?? 'task-orchestrator',
  })
  if (error) throw error
  return data === true
}

export async function cancelAgentTask(input: {
  accountId: string
  taskId: string
  actorId?: string
}): Promise<boolean> {
  const db = supabaseAdmin()
  const { data, error } = await db.rpc('cancel_agent_task', {
    p_account_id: input.accountId,
    p_task_id: input.taskId,
    p_actor_id: input.actorId ?? 'task-orchestrator',
  })
  if (error) throw error
  return data === true
}

export async function scheduleAgentTaskTarget(input: {
  taskId: string
  targetId: string
  nextActionAt: Date
  reason?: string
}): Promise<boolean> {
  const db = supabaseAdmin()
  const { data, error } = await db.rpc('schedule_agent_task_target', {
    p_task_id: input.taskId,
    p_task_target_id: input.targetId,
    p_next_action_at: input.nextActionAt.toISOString(),
    p_reason: input.reason ?? 'followup',
  })
  if (error) throw error
  return data === true
}

async function releaseTaskClaim(
  db: ReturnType<typeof supabaseAdmin>,
  taskId: string,
  workerId: string,
  minimumDelaySeconds: number,
): Promise<void> {
  const { error } = await db.rpc('release_agent_task_claim', {
    p_task_id: taskId,
    p_worker_id: workerId,
    p_min_delay_secs: minimumDelaySeconds,
  })
  if (error) {
    console.error('[task orchestrator] release task claim failed:', error)
  }
}
