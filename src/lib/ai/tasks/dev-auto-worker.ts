import { processAgentTaskQueue } from './orchestrator'
import { processAgentTaskOutboundRunQueue } from './outbound-worker'
import { processAgentTaskTriggerQueue } from './trigger-worker'
import { shouldStartDevAgentTaskWorker } from './dev-auto-worker-settings'

const INTERVAL_MS = 15_000
const WORK_LIMIT = 3

type WorkerState = {
  running: boolean
  interval: ReturnType<typeof setInterval>
  startedAt: number
}

declare global {
  // In Next dev, the instrumentation module may be re-evaluated during HMR.
  // A single in-process timer plus durable SQL claims prevents duplicate ticks.
  // eslint-disable-next-line no-var
  var __wacrmTestAgentTaskAutoWorker: WorkerState | undefined
}

/**
 * TEST-only long-running local scheduler for the EXISTING Agent Task
 * trigger -> orchestrator -> outbound worker chain.
 *
 * It does not perform any direct WhatsApp sends or bypass approvals;
 * outbound reservations, consent, pilot cohorts and reconciliation still use
 * the standard policy/SQL/provider transport. The runner is non-overlapping,
 * bounded, and remains entirely disabled in production / non-TEST projects.
 *
 * It deliberately excludes unrelated workers for approved Change Requests,
 * CRM customer notifications, and general inbound AI recovery.
 */
export function startDevAgentTaskAutoWorker(): boolean {
  if (!shouldStartDevAgentTaskWorker({
    nodeEnv: process.env.NODE_ENV,
    nextRuntime: process.env.NEXT_RUNTIME,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    mode: process.env.WACRM_DEV_AGENT_TASK_WORKER,
  })) {
    return false
  }

  if (globalThis.__wacrmTestAgentTaskAutoWorker) return true

  const instanceId = crypto.randomUUID()
  let sequence = 0

  const state = {
    running: false,
    interval: undefined as unknown as ReturnType<typeof setInterval>,
    startedAt: Date.now(),
  }
  globalThis.__wacrmTestAgentTaskAutoWorker = state

  const tick = async () => {
    if (state.running) return
    state.running = true
    const workerId = `dev-test-agent-tasks:${instanceId}:${++sequence}`
    try {
      const triggers = await processAgentTaskTriggerQueue({
        workerId: workerId + ':triggers', limit: WORK_LIMIT,
      })
      const tasks = await processAgentTaskQueue({
        workerId, limit: WORK_LIMIT,
      })
      const outbound = await processAgentTaskOutboundRunQueue({
        workerId: workerId + ':outbound', limit: WORK_LIMIT,
      })
      if (triggers.completed || triggers.failed || tasks.claimedTasks ||
          tasks.failed || tasks.deferredTasks || outbound.attempted ||
          outbound.denied || outbound.gated || outbound.reconciliation) {
        console.info('[TEST Agent Task auto-worker] tick', {
          triggerCompleted: triggers.completed, triggerFailed: triggers.failed,
          claimedTasks: tasks.claimedTasks, materializedTargets: tasks.materializedTargets,
          createdRuns: tasks.createdRuns, taskFailures: tasks.failed,
          outboundAttempted: outbound.attempted, sent: outbound.sent,
          reconciliation: outbound.reconciliation, denied: outbound.denied,
          gated: outbound.gated,
        })
      }
    } catch (error) {
      // Leave queued work intact. The next bounded tick retries only through
      // existing durable claims; ambiguous provider outcomes are reconciled,
      // never blindly re-sent.
      console.error('[TEST Agent Task auto-worker] tick failed:', error)
    } finally {
      state.running = false
    }
  }

  state.interval = setInterval(() => { void tick() }, INTERVAL_MS)
  state.interval.unref?.()
  setTimeout(() => { void tick() }, 1_000).unref?.()
  console.info('[TEST Agent Task auto-worker] enabled: bounded 3-item ticks every 15s; ' +
    'disable with WACRM_DEV_AGENT_TASK_WORKER=off and restart Next.js. ' +
    'Eligible approved tasks may send WhatsApp messages.')
  return true
}
