import { NextResponse } from 'next/server'
import { requireAgentCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { parseExplicitCoverageContactIds } from '@/lib/services/coverage/selected-targets'
import { deferredTestOpenWATaskReason } from '@/lib/ai/tasks/test-openwa-task-admission'

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
    if (!selected) return NextResponse.json({ taskStatus: task.status, recipients: [], holdReason: null })

    // Display the same TEST preclaim reason used by the Worker, without
    // changing the Task, approving recipients or attempting a WhatsApp send.
    let holdReason: string | null = null
    const connectionId = policy.whatsappConnectionId
    if (typeof connectionId === 'string' && UUID_RE.test(connectionId) &&
        ['queued', 'scheduled', 'running'].includes(task.status)) {
      try {
        holdReason = await deferredTestOpenWATaskReason({
          db, accountId: ctx.accountId, connectionId, contactIds: [...selected],
        })
      } catch (error) {
        // A temporary Pilot status lookup failure must not hide durable
        // per-recipient delivery outcomes from the operator.
        console.warn('[agent-task-progress] TEST preclaim check unavailable',
          { taskId: taskId.slice(0, 8), error })
      }
    }

    // In TEST, when the agent cohort is held by Pilot admission, inspect
    // each frozen recipient independently through the SAME authoritative
    // preclaim routine. Never approve, reserve, send, or expose hashed IDs.
    // Pilot grants are capped at ten exact recipients per cohort.
    const pilotRecipientApproval = new Map<string, 'approved' | 'missing' | 'unverified'>()
    if (holdReason === 'pilot_recipient_not_approved' &&
        typeof connectionId === 'string' && selected.length <= 10) {
      const checks = await Promise.all(selected.map(async contactId => {
        try {
          const reason = await deferredTestOpenWATaskReason({
            db, accountId: ctx.accountId, connectionId, contactIds: [contactId],
          })
          const status: 'approved' | 'missing' | 'unverified' =
            reason === null ? 'approved'
              : reason === 'pilot_recipient_not_approved' ? 'missing' : 'unverified'
          return { contactId, status }
        } catch {
          return { contactId, status: 'unverified' as const }
        }
      }))
      for (const check of checks) pilotRecipientApproval.set(check.contactId, check.status)
    }

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
        .select('task_target_id,status,provider,error_code,error_detail,updated_at')
        .eq('account_id', ctx.accountId).eq('task_id', taskId)
        .in('task_target_id', targetIds)
        .order('updated_at', { ascending: false })
        .limit(selected.length * 20)
      : { data: [], error: null }
    if (outboundResult.error) throw outboundResult.error
    const outbounds = new Map<string, { status: string; provider: string | null; error_code: string | null; error_detail: string | null }>()
    for (const outbound of outboundResult.data ?? []) {
      if (!outbounds.has(outbound.task_target_id)) {
        outbounds.set(outbound.task_target_id, outbound)
      }
    }

    // The supplier negotiation is separate from initial WhatsApp delivery.
    // Show the real administrative proposal lifecycle (or its absence) to
    // the operator without exposing the one-time approval PIN.
    const { data: negotiations, error: negotiationError } = await db
      .from('ai_agent_coverage_supplier_negotiations')
      .select('task_target_id,stage,offered_amount,commission_per_thousand,supplier_details,change_request_id')
      .eq('account_id', ctx.accountId).eq('task_id', taskId)
      .limit(selected.length)
    if (negotiationError) throw negotiationError
    const negotiationByTarget = new Map((negotiations ?? []).map(row =>
      [row.task_target_id, row]))
    const changeRequestIds = (negotiations ?? [])
      .map(row => row.change_request_id).filter((id): id is string => typeof id === 'string')
    const changeResult = changeRequestIds.length
      ? await db.from('change_requests').select('id,code,status')
        .eq('account_id', ctx.accountId).in('id', changeRequestIds)
      : { data: [], error: null }
    if (changeResult.error) throw changeResult.error
    const changesById = new Map((changeResult.data ?? []).map(change => [change.id, change]))

    return NextResponse.json({
      taskStatus: task.status,
      holdReason,
      recipients: selected.map(contactId => {
        const contact = contacts.get(contactId)
        const target = targets.get(contactId)
        const outbound = target ? outbounds.get(target.id) : null
        const negotiation = target ? negotiationByTarget.get(target.id) : null
        const approval = negotiation?.change_request_id
          ? changesById.get(negotiation.change_request_id) : null
        return {
          contactId,
          pilotApproval: pilotRecipientApproval.get(contactId) ?? null,
          name: contact?.name ?? null,
          phone: contact?.phone ?? null,
          targetStatus: target?.status ?? null,
          attemptCount: target?.attempt_count ?? 0,
          skipReason: target?.skip_reason ?? null,
          failureCode: target?.failure_code ?? null,
          outboundStatus: outbound?.status ?? null,
          provider: outbound?.provider ?? null,
          errorCode: outbound?.error_code ?? null,
          // Only recognized policy codes cross the browser boundary.
          denialReason: outbound?.error_code === 'OPENWA_PRE_DISPATCH_DENIED' &&
            /^OPENWA_SEND_BLOCKED_BY_WACRM_GUARDRAIL_[A-Z_]+$/.test(outbound?.error_detail ?? '')
              ? outbound?.error_detail : null,
          supplierStage: negotiation?.stage ?? null,
          offeredAmount: negotiation?.offered_amount ?? null,
          commissionPerThousand: negotiation?.commission_per_thousand ?? null,
          supplierDetails: negotiation?.supplier_details ?? null,
          changeRequestCode: approval?.code ?? null,
          changeRequestStatus: approval?.status ?? null,
        }
      }),
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
