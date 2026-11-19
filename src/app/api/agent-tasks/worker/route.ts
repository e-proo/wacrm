import { NextResponse } from 'next/server'
import { requireAgentCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'
import { evaluateSchedulerPulse } from '@/lib/ai/tasks/scheduler-health'

export const runtime = 'nodejs'
const noStore = { 'Cache-Control': 'private, no-store, max-age=0' }

function deny(error: string, code: string, status: number) {
  return NextResponse.json({ error, code }, { status, headers: noStore })
}

async function status(accountId: string) {
  const db = supabaseAdmin()
  const [
    { data: policy, error: pe },
    { data: tasks, error: te },
    { data: outbound, error: re },
    { data: health, error: he },
  ] = await Promise.all([
    db.from('ai_runtime_policies').select('task_worker_enabled')
      .eq('account_id', accountId).maybeSingle(),
    db.from('ai_agent_tasks').select('status')
      .eq('account_id', accountId)
      .in('status', ['queued', 'scheduled', 'validating', 'running', 'paused'])
      .limit(1000),
    db.from('ai_agent_runs').select('status')
      .eq('account_id', accountId).eq('run_mode', 'outbound')
      .in('status', ['queued', 'claimed', 'running'])
      .limit(1000),
    // Existing SCH-4 RPC: tenant-scoped schedule metrics + one redacted
    // global TEST heartbeat. Never query another account's task rows.
    db.rpc('inspect_agent_task_schedule_health', { p_account_id: accountId }),
  ])
  if (pe || te || re) throw pe ?? te ?? re
  // A heartbeat read failure must not prevent an admin from stopping new
  // work for this account. Report unknown rather than a stale green signal.
  const schedulerUnavailable = Boolean(he || !health || typeof health !== 'object' || Array.isArray(health))
  const counts = { queued: 0, running: 0, paused: 0, scheduled: 0, validating: 0 }
  for (const task of tasks ?? []) {
    const key = task.status as keyof typeof counts
    if (key in counts) counts[key] += 1
  }
  return {
    enabled: policy?.task_worker_enabled !== false,
    scheduler: evaluateSchedulerPulse(schedulerUnavailable ? null : health),
    schedulerUnavailable,
    tasks: counts,
    outbound: {
      queued: (outbound ?? []).filter(row => row.status === 'queued').length,
      inFlight: (outbound ?? []).filter(row =>
        row.status === 'claimed' || row.status === 'running').length,
    },
    scannedAt: new Date().toISOString(),
    // Bounded scan. Avoid pretending counts are exhaustive if >1000.
    truncated: (tasks ?? []).length >= 1000 || (outbound ?? []).length >= 1000,
  }
}

export async function GET() {
  try {
    if (!isOpenWATestProject()) return deny('Worker controls are TEST only', 'TEST_ONLY', 403)
    const ctx = await requireAgentCapability('agents.manage_tasks')
    return NextResponse.json(await status(ctx.accountId), { headers: noStore })
  } catch (error) { return toErrorResponse(error) }
}

/** Per-account durable switch. A STOP prevents new claims; an already
 * provider-dispatched message must finish/reconcile. Never touches WhatsApp
 * sessions, approvals or account's other runtime policy gates.
 */
export async function POST(request: Request) {
  try {
    if (!isOpenWATestProject()) return deny('Worker controls are TEST only', 'TEST_ONLY', 403)
    const ctx = await requireAgentCapability('agents.manage_tasks')
    const body: unknown = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        !('action' in body) ||
        !['start', 'stop'].includes(String(body.action))) {
      return deny('Invalid worker control action', 'INVALID_ACTION', 400)
    }
    const desired = body.action === 'start'
    const { data, error } = await supabaseAdmin().rpc('set_agent_task_worker_enabled', {
      p_account_id: ctx.accountId,
      p_actor_user_id: ctx.userId,
      p_enabled: desired,
    })
    if (error) throw error
    const result = data as { updated?: boolean; reason?: string } | null
    if (!result?.updated) return deny('Worker control was not changed',
      result?.reason ?? 'WORKER_CONTROL_REJECTED', 409)
    return NextResponse.json(await status(ctx.accountId), { headers: noStore })
  } catch (error) { return toErrorResponse(error) }
}
