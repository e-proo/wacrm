import { NextResponse } from 'next/server'
import { requireAgentCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { parseExplicitCoverageContactIds } from '@/lib/services/coverage/selected-targets'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Read-only, per-recipient status for ONE Task. This never claims a run,
 * changes cutover/Pilot state, or re-sends an ambiguous outbound message.
 * Admin-only and account-scoped at every table boundary.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    const ctx = await requireAgentCapability('agents.manage_tasks')
    const { taskId } = await params
    if (!UUID_RE.test(taskId)) {
      return NextResponse.json({ error: 'معرّف مهمة غير صالح.', code: 'INVALID_TASK_ID' }, { status: 400 })
    }

    const db = supabaseAdmin()
    const { data: task, error: taskError } = await db.from('ai_agent_tasks')
      .select('id,task_type,status,target_policy')
      .eq('account_id', ctx.accountId)
      .eq('id', taskId).maybeSingle()
    if (taskError) throw taskError
    if (!task) return NextResponse.json({ error: 'المهمة غير موجودة.', code: 'TASK_NOT_FOUND' }, { status: 404 })

    const policy = task.target_policy && typeof task.target_policy === 'object' &&
      !Array.isArray(task.target_policy) ? task.target_policy as Record<string, unknown> : {}
    let selected: readonly string[] | null
    try {
      selected = task.task_type === 'coverage.sourcing'
        ? parseExplicitCoverageContactIds(policy) : null
    } catch {
      return NextResponse.json({ error: 'قائمة الأرقام المحفوظة غير صالحة.', code: 'TASK_CONTACT_POLICY_INVALID' }, { status: 409 })
    }
    if (!selected) return NextResponse.json({ taskStatus: task.status, recipients: [] })

    const [contactResult, targetResult] = await Promise.all([
      db.from('contacts').select('id,name,phone')
        .eq('account_id', ctx.accountId).in('id', [...selected]).limit(selected.length),
      db.from('ai_agent_task_targets')
        .select('id,contact_id,status,attempt_count,skip_reason,failure_code,last_outbound_message_id')
        .eq('account_id', ctx.accountId).eq('task_id', taskId)
        .in('contact_id', [...selected]).limit(selected.length),
    ])
    if (contactResult.error) throw contactResult.error
    if (targetResult.error) throw targetResult.error

    const contacts = new Map((contactResult.data ?? []).map(c => [c.id, c]))
    const targets = new Map((targetResult.data ?? []).map(t => [t.contact_id, t]))
    const outboundIds = (targetResult.data ?? []).flatMap(t =>
      typeof t.last_outbound_message_id === 'string' ? [t.last_outbound_message_id] : [])
    const outboundResult = outboundIds.length
      ? await db.from('ai_agent_task_outbound_messages')
        .select('local_message_id,status,provider,error_code')
        .eq('account_id', ctx.accountId).eq('task_id', taskId)
        .in('local_message_id', outboundIds).limit(outboundIds.length)
      : { data: [], error: null }
    if (outboundResult.error) throw outboundResult.error
    const outbounds = new Map((outboundResult.data ?? []).map(m => [m.local_message_id, m]))

    return NextResponse.json({
      taskStatus: task.status,
      recipients: selected.map(contactId => {
        const contact = contacts.get(contactId)
        const target = targets.get(contactId)
        const outbound = target?.last_outbound_message_id
          ? outbounds.get(target.last_outbound_message_id) : null
        return {
          contactId,
          name: contact?.name ?? null,
          phone: contact?.phone ?? null,
          targetStatus: target?.status ?? null,
          attemptCount: target?.attempt_count ?? 0,
          skipReason: target?.skip_reason ?? null,
          failureCode: target?.failure_code ?? null,
          outboundStatus: outbound?.status ?? null,
          provider: outbound?.provider ?? null,
          errorCode: outbound?.error_code ?? null,
        }
      }),
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
