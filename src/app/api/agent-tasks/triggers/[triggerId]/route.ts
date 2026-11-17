import { NextResponse } from 'next/server'
import { requireAgentCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store, max-age=0' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Explicit pause/enable; account scoped before service-role mutation.
 * Enabling requires owner publish permission plus a separate TEST-only gate,
 * never a side effect of creation or policy edit.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ triggerId: string }> },
) {
  try {
    const ctx = await requireAgentCapability('agents.manage_tasks')
    const rate = checkRateLimit('admin:triggerControl:' + ctx.userId, RATE_LIMITS.adminAction)
    if (!rate.success) return rateLimitResponse(rate)
    const { triggerId } = await params
    const body: unknown = await request.json().catch(() => null)
    if (!UUID.test(triggerId) || !body || typeof body !== 'object' || Array.isArray(body) ||
        !('status' in body) || (body.status !== 'paused' && body.status !== 'enabled')) {
      return NextResponse.json({ error: 'طلب تعديل الجدولة غير صالح.', code: 'INVALID_TRIGGER_CONTROL' },
        { status: 400, headers })
    }
    const db = supabaseAdmin()
    const { data: trigger, error: triggerError } = await db.from('ai_agent_task_triggers')
      .select('id,status,approved_revision_id,agent_id')
      .eq('account_id', ctx.accountId).eq('id', triggerId).maybeSingle()
    if (triggerError) throw triggerError
    if (!trigger) return NextResponse.json({ error: 'الجدولة غير موجودة.', code: 'TRIGGER_NOT_FOUND' },
      { status: 404, headers })
    if (body.status === 'enabled') {
      await requireAgentCapability('agents.publish')
      if (process.env.WACRM_AGENT_TASK_SCHEDULING_ENABLE_TEST !== '1' ||
          !isOpenWATestProject() || !('confirmEnable' in body) ||
          body.confirmEnable !== true) {
        return NextResponse.json({
          error: 'التمكين يتطلب اعتمادًا صريحًا وبيئة TEST مفعلة، ولا يسمح بالإرسال التلقائي الآن.',
          code: 'SCHEDULE_LIVE_ENABLE_NOT_AUTHORIZED',
        }, { status: 409, headers })
      }
      if (!trigger.approved_revision_id) {
        return NextResponse.json({ error: 'الجدولة غير مرتبطة بنسخة معتمدة.', code: 'SCHEDULE_APPROVAL_REQUIRED' },
          { status: 409, headers })
      }
      const { data: agent, error: agentError } = await db.from('ai_agents')
        .select('id,published_revision_id,status')
        .eq('account_id', ctx.accountId).eq('id', trigger.agent_id).maybeSingle()
      if (agentError) throw agentError
      if (!agent || agent.status !== 'active' ||
          agent.published_revision_id !== trigger.approved_revision_id) {
        return NextResponse.json({ error: 'تغيّرت النسخة المنشورة؛ أنشئ سياسة جديدة للمراجعة.', code: 'SCHEDULE_REVISION_CHANGED' },
          { status: 409, headers })
      }
    }
    const { data: updated, error } = await db.rpc('set_agent_task_trigger_status', {
      p_account_id: ctx.accountId, p_trigger_id: triggerId, p_status: body.status,
    })
    if (error) throw error
    if (updated !== true) {
      return NextResponse.json({ error: 'لم تُغيّر الحالة. تحقق من حالة الجدولة.', code: 'SCHEDULE_STATUS_CONFLICT' },
        { status: 409, headers })
    }
    return NextResponse.json({ id: triggerId, status: body.status }, { headers })
  } catch (error) {
    return toErrorResponse(error)
  }
}
