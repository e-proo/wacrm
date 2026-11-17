import { NextResponse } from 'next/server'
import { requireAgentCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { CURRENT_AGENT_TASK_TRIGGER_REGISTRY } from '@/lib/ai/tasks/current-platform'
import { parseScheduleDraft, ScheduleValidationError } from '@/lib/ai/tasks/schedule-admin'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store, max-age=0' }

/** Strictly account-scoped admin inventory. Never expose provider/session credentials,
 * raw Business Event payloads, revision secrets, or unredacted error details.
 */
export async function GET() {
  try {
    const ctx = await requireAgentCapability('agents.manage_tasks')
    const db = supabaseAdmin()
    const [
      { data: rules, error: rulesError },
      { data: firings, error: firingsError },
      { data: agents, error: agentsError },
      { data: requests, error: requestError },
      { data: services, error: servicesError },
      { data: runtimePolicy, error: policyError },
    ] = await Promise.all([
      db.from('ai_agent_task_triggers')
        .select('id,task_type,task_type_version,agent_id,trigger_kind,status,schedule_kind,next_fire_at,interval_minutes,event_type,config,created_at,policy_version,overlap_policy,approved_revision_id,skipped_occurrences,edited_at,cancelled_at')
        .eq('account_id', ctx.accountId).order('created_at', { ascending: false }).limit(100),
      db.from('ai_agent_task_trigger_firings')
        .select('id,trigger_id,status,attempts,created_at,scheduled_for,available_at,skip_reason,last_error,task_id')
        .eq('account_id', ctx.accountId).order('created_at', { ascending: false }).limit(300),
      db.from('ai_agents').select('id,name,status,published_revision_id')
        .eq('account_id', ctx.accountId).eq('status', 'active')
        .order('name', { ascending: true }).limit(100),
      db.from('coverage_requests').select('id,status')
        .eq('account_id', ctx.accountId).order('created_at', { ascending: false }).limit(100),
      db.from('services').select('id,name,status')
        .eq('account_id', ctx.accountId).eq('status', 'active')
        .order('name', { ascending: true }).limit(100),
      db.from('ai_runtime_policies').select('agent_task_trigger_max_pending,task_worker_enabled')
        .eq('account_id', ctx.accountId).maybeSingle(),
    ])
    const err = rulesError ?? firingsError ?? agentsError ??
      requestError ?? servicesError ?? policyError
    if (err) throw err
    const byTrigger = new Map<string, Array<Record<string, unknown>>>()
    for (const f of firings ?? []) {
      const key = f.trigger_id as string
      const list = byTrigger.get(key) ?? []
      if (list.length < 8) {
        list.push({
          id: f.id, status: f.status, attempts: f.attempts, taskId: f.task_id,
          scheduledFor: f.scheduled_for, createdAt: f.created_at,
          availableAt: f.available_at, skipReason: f.skip_reason,
          reason: typeof f.last_error === 'string' && /^[A-Z0-9_:.@-]{1,100}$/.test(f.last_error)
            ? f.last_error : null,
        })
        byTrigger.set(key, list)
      }
    }
    return NextResponse.json({
      rules: (rules ?? []).map(t => {
        const config = t.config && typeof t.config === 'object' && !Array.isArray(t.config)
          ? t.config as Record<string, unknown> : {}
        return {
          id: t.id, taskType: t.task_type, version: t.task_type_version,
          agentId: t.agent_id, triggerKind: t.trigger_kind, status: t.status,
          scheduleKind: t.schedule_kind, nextFireAt: t.next_fire_at,
          intervalMinutes: t.interval_minutes, eventType: t.event_type,
          subjectId: typeof config.coverageRequestId === 'string'
            ? config.coverageRequestId : typeof config.serviceId === 'string'
              ? config.serviceId : null,
          policyVersion: t.policy_version, overlapPolicy: t.overlap_policy,
          approvedRevisionId: t.approved_revision_id,
          skippedOccurrences: t.skipped_occurrences,
          createdAt: t.created_at, editedAt: t.edited_at, cancelledAt: t.cancelled_at,
          firings: byTrigger.get(t.id) ?? [],
        }
      }),
      agents: (agents ?? []).map(a => ({
        id: a.id, name: a.name, publishedRevisionId: a.published_revision_id,
      })),
      coverageRequests: requests ?? [],
      services: services ?? [],
      maxPendingPerAccount: runtimePolicy?.agent_task_trigger_max_pending ?? 100,
      taskWorkerEnabled: runtimePolicy?.task_worker_enabled !== false,
      enableAllowedInTest: process.env.WACRM_AGENT_TASK_SCHEDULING_ENABLE_TEST === '1',
    }, { headers })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/** Create an explicitly reviewed schedule or approved Coverage event.
 * Always persist PAUSED, never implicitly authorize live delivery.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAgentCapability('agents.manage_tasks')
    const rate = checkRateLimit('admin:triggerCreate:' + ctx.userId, RATE_LIMITS.adminAction)
    if (!rate.success) return rateLimitResponse(rate)
    let draft: ReturnType<typeof parseScheduleDraft>
    try {
      draft = parseScheduleDraft(await request.json().catch(() => null))
    } catch (error) {
      if (error instanceof ScheduleValidationError) {
        return NextResponse.json({ error: error.message, code: error.code },
          { status: 400, headers })
      }
      throw error
    }
    const definition = { ...draft.definition, accountId: ctx.accountId, createdBy: ctx.userId }
    if (definition.taskType === 'services.promotion') {
      await requireAgentCapability('agents.manage_outreach')
    }
    const handler = CURRENT_AGENT_TASK_TRIGGER_REGISTRY.get(
      definition.taskType, definition.taskTypeVersion)
    if (!handler) {
      return NextResponse.json({ error: 'نوع المهمة غير مدعوم حاليًا.', code: 'HANDLER_NOT_REGISTERED' },
        { status: 400, headers })
    }
    try {
      handler.validate(definition)
    } catch {
      return NextResponse.json({ error: 'بيانات مهمة الجدولة لا تطابق العقد المعتمد.', code: 'TRIGGER_POLICY_INVALID' },
        { status: 400, headers })
    }
    const db = supabaseAdmin()
    const { data: agent, error: agentError } = await db
      .from('ai_agents').select('id,published_revision_id,status')
      .eq('account_id', ctx.accountId).eq('id', definition.agentId).maybeSingle()
    if (agentError) throw agentError
    if (!agent || agent.status !== 'active' || !agent.published_revision_id) {
      return NextResponse.json({ error: 'الوكيل غير نشط أو لا يملك نسخة منشورة.', code: 'PUBLISHED_AGENT_REQUIRED' },
        { status: 409, headers })
    }
    const sourceTable = definition.taskType === 'coverage.sourcing' ? 'coverage_requests' : 'services'
    const subjectId = definition.triggerKind === 'business_event'
      ? draft.subjectId : definition.taskType === 'coverage.sourcing'
        ? definition.config.coverageRequestId : definition.config.serviceId
    if (typeof subjectId !== 'string') {
      return NextResponse.json({ error: 'مصدر الجدولة غير صالح.', code: 'SOURCE_REQUIRED' },
        { status: 400, headers })
    }
    const { data: subject, error: subjectError } = await db.from(sourceTable)
      .select('id').eq('account_id', ctx.accountId).eq('id', subjectId).maybeSingle()
    if (subjectError) throw subjectError
    if (!subject) {
      return NextResponse.json({ error: 'المصدر غير موجود ضمن هذا الحساب.', code: 'SOURCE_NOT_FOUND' },
        { status: 404, headers })
    }
    const { data: id, error } = await db.rpc('create_reviewed_agent_task_trigger', {
      p_account_id: ctx.accountId,
      p_task_type: definition.taskType,
      p_task_type_version: definition.taskTypeVersion,
      p_agent_id: definition.agentId,
      p_trigger_kind: definition.triggerKind,
      p_schedule_kind: definition.scheduleKind ?? null,
      p_next_fire_at: definition.nextFireAt ?? null,
      p_interval_minutes: definition.intervalMinutes ?? null,
      p_event_type: definition.eventType ?? null,
      p_event_version: definition.eventVersion ?? null,
      p_config: definition.config,
      p_filters: definition.filters ?? {},
      p_idempotency_key: definition.idempotencyKey,
      p_actor: ctx.userId,
      p_approved_revision_id: agent.published_revision_id,
      p_overlap_policy: draft.overlapPolicy,
    })
    if (error) {
      const conflict = typeof error.message === 'string' &&
        /IDEMPOTENCY_POLICY_CONFLICT|REVIEW_CONFLICT|REVISION_NOT_PUBLISHED/.test(error.message)
      return NextResponse.json({
        error: conflict ? 'تعارض في نسخة سياسة الجدولة أو النسخة المنشورة.' : 'تعذّر حفظ سياسة الجدولة.',
        code: conflict ? 'SCHEDULE_POLICY_CONFLICT' : 'SCHEDULE_CREATE_FAILED',
      }, { status: conflict ? 409 : 500, headers })
    }
    if (typeof id !== 'string') throw new Error('SCHEDULE_CREATE_RESULT_INVALID')
    return NextResponse.json({ id, status: 'paused', message: 'تم الحفظ بحالة إيقاف. لم يتم إرسال أي رسالة.' },
      { status: 201, headers })
  } catch (error) {
    return toErrorResponse(error)
  }
}
