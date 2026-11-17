import { NextResponse } from 'next/server'
import { requireAgentCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store, max-age=0' }

type Metrics = {
  enabledSchedules: number; backlog: number; backlogCap: number
  dead: number; staleClaims: number; dueLagSeconds: number
  backlogLagSeconds: number; taskWorkerEnabled: boolean
  runnerLastSucceededAt: string | null; runnerConsecutiveFailures: number
  observedAt: string
}
const numeric = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value : 0

/** A redacted, strictly tenant-scoped read. No Task dispatch is reachable here. */
export async function GET() {
  try {
    if (!isOpenWATestProject()) {
      return NextResponse.json({error:'TEST only',code:'TEST_ONLY'},
        {status:403,headers})
    }
    const ctx = await requireAgentCapability('agents.manage_tasks')
    const { data, error } = await supabaseAdmin().rpc(
      'inspect_agent_task_schedule_health', { p_account_id: ctx.accountId })
    if (error) throw error
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('SCHEDULE_HEALTH_RESULT_INVALID')
    }
    const health = data as Metrics
    const active = Boolean(health.taskWorkerEnabled) &&
      (numeric(health.enabledSchedules) > 0 || numeric(health.backlog) > 0)
    const age = health.runnerLastSucceededAt
      ? Date.parse(health.observedAt) - Date.parse(health.runnerLastSucceededAt)
      : Number.POSITIVE_INFINITY
    const alerts: string[] = []
    if (numeric(health.staleClaims) > 0) alerts.push('STALE_CLAIMS')
    if (numeric(health.dead) > 0) alerts.push('DEAD_FIRINGS')
    if (numeric(health.backlogCap) > 0 &&
        numeric(health.backlog) >= Math.ceil(numeric(health.backlogCap) * 0.8)) {
      alerts.push('BACKLOG_NEAR_CAP')
    }
    if (numeric(health.dueLagSeconds) > 300 ||
        numeric(health.backlogLagSeconds) > 300) alerts.push('SCHEDULER_LAG')
    if (numeric(health.runnerConsecutiveFailures) > 0) alerts.push('WORKER_ERRORS')
    if (active && (!Number.isFinite(age) || age > 15 * 60_000)) {
      alerts.push('WORKER_HEARTBEAT_STALE')
    }
    return NextResponse.json({health,alerts}, {headers})
  } catch (error) { return toErrorResponse(error) }
}
