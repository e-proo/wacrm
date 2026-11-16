import { NextResponse } from 'next/server'
import { requireAgentCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { pauseAgentTask, resumeAgentTask } from '@/lib/ai/tasks/orchestrator'

type Context = { params: Promise<{ taskId: string }> }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const noStore = { 'Cache-Control': 'private, no-store, max-age=0' }
const denial = (code: string, status = 409) =>
  NextResponse.json({ error: code, code }, { status, headers: noStore })

/** Terminalization is one atomic, account-scoped database action. It cancels
 * only unsent queued work and refuses an active send/uncertain outcome. User
 * choices do not override actual evidence of task/domain completion.
 */
export async function POST(request: Request, context: Context) {
  try {
    const ctx = await requireAgentCapability('agents.manage_tasks')
    const { taskId } = await context.params
    if (!UUID.test(taskId)) return denial('INVALID_TASK_ID', 400)
    const body: unknown = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        !('action' in body)) return denial('INVALID_TASK_ACTION', 400)
    const action = body.action
    if (!['pause','resume','cancel','finish_incomplete','finish_complete'].includes(String(action))) {
      return denial('INVALID_TASK_ACTION', 400)
    }
    const note = 'note' in body ? body.note : null
    if (note !== null && (typeof note !== 'string' || note.length > 500)) {
      return denial('INVALID_CLOSURE_NOTE', 400)
    }
    if (action === 'pause' || action === 'resume') {
      const changed = action === 'pause'
        ? await pauseAgentTask({ accountId: ctx.accountId, taskId, actorId: ctx.userId })
        : await resumeAgentTask({ accountId: ctx.accountId, taskId, actorId: ctx.userId })
      if (!changed) return denial('TASK_STATE_CHANGED_OR_NOT_FOUND')
      return NextResponse.json({ updated: true, status: action === 'pause' ? 'paused' : 'queued' },
        { headers: noStore })
    }
    const { data, error } = await supabaseAdmin().rpc('admin_close_agent_task', {
      p_account_id: ctx.accountId,
      p_task_id: taskId,
      p_actor_user_id: ctx.userId,
      p_mode: action,
      p_note: note,
    })
    if (error) throw error
    const result = data as { updated?: boolean; reason?: string; status?: string;
      closure_kind?: string; total?: number; completed?: number } | null
    if (result?.updated !== true) return NextResponse.json({
      error: result?.reason ?? 'TASK_CLOSE_REJECTED', code: result?.reason ?? 'TASK_CLOSE_REJECTED',
    }, { status: 409, headers: noStore })
    return NextResponse.json(result, { headers: noStore })
  } catch (error) { return toErrorResponse(error) }
}
