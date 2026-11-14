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
    // A reservation may exist before a durable messages.id is assigned. Query
    // by the per-target reservation FK, not last_outbound_message_id (which
    // references messages.id), so ambiguous/unsettled attempts remain visible.
    const targetIds = (targetResult.data ?? []).map(t => t.id)
    const outboundResult = targetIds.length
      ? await db.from('ai_agent_task_outbound_messages')
        .select('task_target_id,status,provider,error_code,updated_at')
        .eq('account_id', ctx.accountId).eq('task_id', taskId)
        .in('task_target_id', targetIds)
        .order('updated_at', { ascending: false })
        .limit(selected.length * 20)
      : { data: [], error: null }
    if (outboundResult.error) throw outboundResult.error
    const outbounds = new Map<string, { status: string; provider: string | null; error_code: string | null }>()
    for (const outbound of outboundResult.data ?? []) {
      if (!outbounds.has(outbound.task_target_id)) {
        outbounds.set(outbound.task_target_id, outbound)
      }
    }

    return NextResponse.json({
      taskStatus: task.status,
      recipients: selected.map(contactId => {
        const contact = contacts.get(contactId)
        const target = targets.get(contactId)
        const outbound = target ? outbounds.get(target.id) : null
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
