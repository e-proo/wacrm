import { NextResponse } from 'next/server'
import { requireAgentCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const headers = { 'Cache-Control': 'private, no-store, max-age=0' }

/** Bounded, account-scoped audit. Firing completion is NOT message delivery. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ triggerId: string }> },
) {
  try {
    const ctx = await requireAgentCapability('agents.manage_tasks')
    const { triggerId } = await params
    if (!UUID.test(triggerId)) {
      return NextResponse.json({ error: 'معرّف الجدولة غير صالح.', code: 'INVALID_TRIGGER_ID' },
        { status: 400, headers })
    }
    const db = supabaseAdmin()
    const { data: trigger, error: triggerError } = await db.from('ai_agent_task_triggers')
      .select('id,status').eq('account_id', ctx.accountId)
      .eq('id', triggerId).maybeSingle()
    if (triggerError) throw triggerError
    if (!trigger) {
      return NextResponse.json({ error: 'الجدولة غير موجودة.', code: 'TRIGGER_NOT_FOUND' },
        { status: 404, headers })
    }
    const { data, error } = await db.from('ai_agent_task_trigger_firings')
      .select('id,status,source_kind,attempts,created_at,scheduled_for,available_at,skip_reason,last_error,task_id,policy_snapshot')
      .eq('account_id', ctx.accountId).eq('trigger_id', triggerId)
      .order('created_at', { ascending: false }).limit(50)
    if (error) throw error
    return NextResponse.json({
      triggerStatus: trigger.status,
      firings: (data ?? []).map(row => ({
        id: row.id, status: row.status, attempts: row.attempts,
        createdAt: row.created_at, availableAt: row.available_at,
        scheduledFor: row.scheduled_for, taskId: row.task_id,
        skipReason: row.skip_reason,
        policyVersion: row.policy_snapshot && typeof row.policy_snapshot === 'object' &&
          !Array.isArray(row.policy_snapshot) && typeof row.policy_snapshot.policy_version === 'number'
          ? row.policy_snapshot.policy_version : null,
        reason: typeof row.last_error === 'string' && /^[A-Z0-9_:.@-]{1,100}$/.test(row.last_error)
          ? row.last_error : null,
      })),
    }, { headers })
  } catch (error) {
    return toErrorResponse(error)
  }
}
