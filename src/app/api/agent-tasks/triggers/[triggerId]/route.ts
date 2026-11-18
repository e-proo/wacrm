import { NextResponse } from 'next/server'
import { requireAgentCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { parseSchedulePolicyEdit, ScheduleValidationError } from '@/lib/ai/tasks/schedule-admin'

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
        !(('status' in body && (body.status === 'paused' || body.status === 'enabled')) ||
          ('action' in body && body.action === 'edit'))) {
      return NextResponse.json({ error: 'طلب تعديل الجدولة غير صالح.', code: 'INVALID_TRIGGER_CONTROL' },
        { status: 400, headers })
    }
    const db = supabaseAdmin()
    const { data: trigger, error: triggerError } = await db.from('ai_agent_task_triggers')
      .select('id,status,approved_revision_id,agent_id,trigger_kind,next_fire_at')
      .eq('account_id', ctx.accountId).eq('id', triggerId).maybeSingle()
    if (triggerError) throw triggerError
    if (!trigger) return NextResponse.json({ error: 'الجدولة غير موجودة.', code: 'TRIGGER_NOT_FOUND' },
      { status: 404, headers })
    if ('action' in body && body.action === 'edit') {
      let draft: ReturnType<typeof parseSchedulePolicyEdit>
      try { draft = parseSchedulePolicyEdit(body) }
      catch (error) {
        if (error instanceof ScheduleValidationError)
          return NextResponse.json({error:error.message,code:error.code},{status:400,headers})
        throw error
      }
      if (trigger.status !== 'paused')
        return NextResponse.json({error:'يجب إيقاف الجدولة قبل تعديلها.',code:'REQUIRES_PAUSE'},
          {status:409,headers})
      const {data, error} = await db.rpc('update_reviewed_agent_task_trigger_policy',{
        p_account_id:ctx.accountId,p_trigger_id:triggerId,p_actor_user_id:ctx.userId,
        p_expected_policy_version:draft.expectedPolicyVersion,
        p_schedule_kind:draft.scheduleKind,p_next_fire_at:draft.nextFireAt,
        p_interval_minutes:draft.intervalMinutes,p_overlap_policy:draft.overlapPolicy,
      })
      if (error) return NextResponse.json({
        error:'تعذّر تعديل الجدولة. راجع البيانات والصلاحيات.',code:'SCHEDULE_EDIT_FAILED',
      },{status:409,headers})
      if (!data || data.updated !== true) {
        const reason = typeof data?.reason === 'string' ? data.reason:'POLICY_CONFLICT'
        return NextResponse.json({
          error:reason==='CLAIM_IN_FLIGHT'?'هناك مهمة قيد الحجز؛ انتظر التسوية قبل تعديل السياسة.'
            :'تغيّرت حالة أو نسخة السياسة؛ قم بتحديث القائمة.',
          code:reason,
        },{status:reason==='NOT_FOUND'?404:409,headers})
      }
      return NextResponse.json({
        id:triggerId,status:'paused',updated:true,policyVersion:data.policy_version,
        skippedFirings:data.skipped_firings??0,tasksUntouched:true,
      },{headers})
    }
    // The edit branch returns above; narrow the remaining request to status
    // controls before reading it (both compile-time and runtime fence).
    if (!('status' in body)) {
      return NextResponse.json({ error: 'حالة الجدولة غير صالحة.', code: 'INVALID_TRIGGER_CONTROL' },
        { status: 400, headers })
    }
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
      // Enabling a stale, paused schedule would fire immediately without a
      // fresh reviewed time. Require an explicit edit to a future due date.
      if (trigger.trigger_kind === 'schedule' &&
        (!trigger.next_fire_at ||
         !Number.isFinite(Date.parse(trigger.next_fire_at)) ||
         Date.parse(trigger.next_fire_at) <= Date.now() + 60_000)) {
        return NextResponse.json({
          error: 'الموعد المحدد مضى أو أصبح قريبًا جدًا. عدّل الموعد إلى وقت قادم ثم فعّل TEST.',
          code: 'SCHEDULE_NEXT_FIRE_REVIEW_REQUIRED',
        }, {status:409,headers})
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
    const { data: updated, error } = await db.rpc('set_reviewed_agent_task_trigger_status', {
      p_account_id: ctx.accountId, p_trigger_id: triggerId, p_status: body.status,
      p_actor_user_id: ctx.userId,
    })
    if (error) {
      const code = typeof error.message === 'string' &&
        /AGENT_TASK_TRIGGER_(?:REVIEW_REVISION_CHANGED|ENABLE_OWNER_ONLY|CONTROL_UNAUTHORIZED)/.test(error.message)
          ? 'SCHEDULE_APPROVAL_CONFLICT' : 'SCHEDULE_STATUS_UPDATE_FAILED'
      return NextResponse.json({ error: 'تعذّر تغيير حالة الجدولة بسبب مراجعة الصلاحيات أو النسخة المنشورة.', code },
        { status: code === 'SCHEDULE_APPROVAL_CONFLICT' ? 409 : 500, headers })
    }
    if (updated !== true) {
      return NextResponse.json({ error: 'لم تُغيّر الحالة. تحقق من حالة الجدولة.', code: 'SCHEDULE_STATUS_CONFLICT' },
        { status: 409, headers })
    }
    return NextResponse.json({ id: triggerId, status: body.status }, { headers })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/** Terminal policy cancellation: audit and already-created Tasks are preserved. */
export async function DELETE(
 request: Request,
 {params}:{params:Promise<{triggerId:string}>},
) {
 try {
  const ctx=await requireAgentCapability('agents.manage_tasks')
  const rate=checkRateLimit('admin:triggerCancel:'+ctx.userId,RATE_LIMITS.adminAction)
  if (!rate.success) return rateLimitResponse(rate)
  const {triggerId}=await params
  const body:unknown=await request.json().catch(()=>null)
  if (!UUID.test(triggerId)||!body||typeof body!=='object'||Array.isArray(body)||
    !('confirmCancel' in body)||body.confirmCancel!==true||
    !('expectedPolicyVersion' in body)||!Number.isInteger(body.expectedPolicyVersion)||
    Number(body.expectedPolicyVersion)<1)
    return NextResponse.json({
      error:'يجب تأكيد الإلغاء وتحديد نسخة السياسة.',code:'SCHEDULE_CANCEL_INVALID',
    },{status:400,headers})
  const db=supabaseAdmin()
  const {data:trigger,error:lookupError}=await db.from('ai_agent_task_triggers')
    .select('id').eq('account_id',ctx.accountId).eq('id',triggerId).maybeSingle()
  if (lookupError) throw lookupError
  if (!trigger) return NextResponse.json({error:'السياسة غير موجودة.',code:'TRIGGER_NOT_FOUND'},
    {status:404,headers})
  const {data,error}=await db.rpc('cancel_reviewed_agent_task_trigger',{
    p_account_id:ctx.accountId,p_trigger_id:triggerId,
    p_actor_user_id:ctx.userId,p_expected_policy_version:body.expectedPolicyVersion,
  })
  if (error) return NextResponse.json({error:'تعذّر إلغاء السياسة.',code:'SCHEDULE_CANCEL_FAILED'},
    {status:409,headers})
  if (!data||data.cancelled!==true) {
    const reason=typeof data?.reason==='string'?data.reason:'POLICY_CONFLICT'
    return NextResponse.json({
      error:reason==='CLAIM_IN_FLIGHT'
        ?'يوجد حجز فعّال؛ انتظر التسوية أو راجع المهمة الجارية قبل إلغاء الجدولة.'
        :'تغيّرت السياسة. حدّث القائمة ثم أعد المحاولة.',code:reason,
    },{status:reason==='NOT_FOUND'?404:409,headers})
  }
  return NextResponse.json({
    id:triggerId,status:'cancelled',alreadyCancelled:data.already_cancelled===true,
    skippedFirings:data.skipped_firings??0,
    linkedTasksUntouched:data.linked_tasks_untouched??0,tasksUntouched:true,
  },{headers})
 } catch(error){return toErrorResponse(error)}
}
