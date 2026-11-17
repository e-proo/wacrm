import { NextResponse } from 'next/server'
import { requireAgentCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { CURRENT_AGENT_TASK_TRIGGER_REGISTRY } from '@/lib/ai/tasks/current-platform'
import { parseScheduleDraft, ScheduleValidationError } from '@/lib/ai/tasks/schedule-admin'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'
import { inspectServicePromotionCampaign, assertPromotionReviewFresh, ServicePromotionReviewError } from '@/lib/services/service-catalog/promotion-campaign-review'

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
      { data: connections, error: connectionsError },
      { data: contacts, error: contactsError },
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
      db.from('whatsapp_connections')
        .select('id,display_name,provider,status,session_id,archived_at')
        .eq('account_id', ctx.accountId).order('updated_at', { ascending: false }).limit(100),
      db.from('contacts').select('id,name,phone_normalized')
        .eq('account_id', ctx.accountId).order('created_at', { ascending: false }).limit(100),
      db.from('ai_runtime_policies').select('agent_task_trigger_max_pending,task_worker_enabled')
        .eq('account_id', ctx.accountId).maybeSingle(),
    ])
    const err = rulesError ?? firingsError ?? agentsError ??
      requestError ?? servicesError ?? connectionsError ?? contactsError ?? policyError
    if (err) throw err
    const taskIds = [...new Set((firings ?? [])
      .map(f => f.task_id).filter((id): id is string => typeof id === 'string'))].slice(0, 300)
    const taskStatuses = new Map<string, string>()
    if (taskIds.length > 0) {
      const { data: taskRows, error: taskError } = await db.from('ai_agent_tasks')
        .select('id,status').eq('account_id', ctx.accountId).in('id', taskIds)
      if (taskError) throw taskError
      for (const task of taskRows ?? []) taskStatuses.set(task.id, task.status)
    }
    const byTrigger = new Map<string, Array<Record<string, unknown>>>()
    for (const f of firings ?? []) {
      const key = f.trigger_id as string
      const list = byTrigger.get(key) ?? []
      if (list.length < 8) {
        list.push({
          id: f.id, status: f.status, attempts: f.attempts, taskId: f.task_id,
          taskStatus: f.task_id ? taskStatuses.get(f.task_id) ?? null : null,
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
      connections: (connections ?? []).map(c => ({
        id: c.id, name: c.display_name ?? c.provider,
        provider: c.provider,
        ready: !c.archived_at && (c.provider === 'meta_cloud' && c.status === 'connected' ||
          c.provider === 'openwa' && ['ready','connected'].includes(c.status) && !!c.session_id),
      })),
      contacts: (contacts ?? []).map(c => ({
        id: c.id, name: c.name || c.phone_normalized || c.id.slice(0,8),
      })),
      maxPendingPerAccount: runtimePolicy?.agent_task_trigger_max_pending ?? 100,
      taskWorkerEnabled: runtimePolicy?.task_worker_enabled !== false,
      enableAllowedInTest: process.env.WACRM_AGENT_TASK_SCHEDULING_ENABLE_TEST === '1' && isOpenWATestProject(),
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
    const submitted: unknown = await request.json().catch(() => null)
    try {
      draft = parseScheduleDraft(submitted)
    } catch (error) {
      if (error instanceof ScheduleValidationError) {
        return NextResponse.json({ error: error.message, code: error.code },
          { status: 400, headers })
      }
      throw error
    }
    let definition = { ...draft.definition, accountId: ctx.accountId, createdBy: ctx.userId }
    const db = supabaseAdmin()
    if (definition.taskType === 'services.promotion') {
      await requireAgentCapability('agents.manage_outreach')
      const raw = submitted && typeof submitted === 'object' && !Array.isArray(submitted)
        ? submitted as Record<string, unknown> : {}
      const preview = raw.promotionReview
      const approved = preview && typeof preview === 'object' && !Array.isArray(preview)
        ? preview as Record<string, unknown> : {}
      const connectionId = raw.connectionId
      if (typeof connectionId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(connectionId) ||
          typeof approved.fingerprint !== 'string' ||
          typeof approved.reviewedAt !== 'string' ||
          approved.consentAcknowledged !== true ||
          approved.approvalAcknowledged !== true ||
          (definition.scheduleKind === 'recurring' && approved.recurringAcknowledged !== true)) {
        return NextResponse.json({
          code: 'PROMOTION_SCHEDULE_REVIEW_REQUIRED',
          error: 'راجع الجمهور والاتصال ووافق صراحة على الحملة والتكرار قبل حفظ الجدولة.',
        }, { status: 400, headers })
      }
      try {
        const campaign = await inspectServicePromotionCampaign(db, {
          accountId: ctx.accountId, serviceId: definition.config.serviceId as string,
          agentId: definition.agentId, connectionId,
        })
        assertPromotionReviewFresh({
          fingerprint: approved.fingerprint, reviewedAt: approved.reviewedAt,
          actualFingerprint: campaign.fingerprint,
        })
        if (campaign.blockers.length > 0 || campaign.audience.count < 1) {
          return NextResponse.json({
            code: 'PROMOTION_SCHEDULE_REVIEW_BLOCKED',
            error: 'الجمهور أو الاتصال أو بوابات الحملة غير جاهزة؛ أصلح الأسباب ثم راجع الحملة من جديد.',
          }, { status: 409, headers })
        }
        const frozen = {
          schemaVersion: 1, serviceId: definition.config.serviceId,
          agentId: definition.agentId, approvedRevisionId: campaign.agent.revisionId,
          approvedBy: ctx.userId, connectionId: campaign.connection.id,
          provider: campaign.connection.provider, fingerprint: campaign.fingerprint,
          // Using the server-preview instant keeps identical retry payloads byte-stable.
          reviewedAt: approved.reviewedAt, approvedAt: approved.reviewedAt,
          frozenContactIds: [...campaign.audience.ids],
          consentAcknowledged: true, approvalAcknowledged: true,
          recurringAcknowledged: approved.recurringAcknowledged === true,
        }
        definition = {
          ...definition,
          config: { ...definition.config, connectionId, promotionReview: frozen },
        }
      } catch (error) {
        if (error instanceof ServicePromotionReviewError ||
            error instanceof Error && error.message.startsWith('SERVICE_PROMOTION_')) {
          return NextResponse.json({
            code: 'PROMOTION_SCHEDULE_REVIEW_STALE',
            error: 'تغيّرت بيانات الحملة أو انتهت صلاحية المعاينة. أعد مراجعتها.',
          }, { status: 409, headers })
        }
        throw error
      }
    } else if (definition.taskType === 'coverage.sourcing' &&
               definition.taskTypeVersion === 2) {
      const connectionId = definition.config.whatsappConnectionId as string
      const { data: connection, error: connectionError } = await db
        .from('whatsapp_connections')
        .select('id,provider,status,session_id,archived_at')
        .eq('account_id', ctx.accountId).eq('id', connectionId).maybeSingle()
      if (connectionError) throw connectionError
      const ready = connection && !connection.archived_at && (
        connection.provider === 'meta_cloud' && connection.status === 'connected' ||
        connection.provider === 'openwa' && ['ready','connected'].includes(connection.status) &&
          !!connection.session_id)
      if (!ready) return NextResponse.json({
        code: 'SCHEDULE_CONNECTION_UNAVAILABLE', error: 'الاتصال غير جاهز ضمن الحساب.',
      }, { status: 409, headers })
      const ids = definition.config.selectedContactIds as string[]
      if (ids.length === 0) {
        return NextResponse.json({
          code: 'SCHEDULE_EXPLICIT_CONTACTS_REQUIRED',
          error: 'اختر جهات اتصال محددة ومراجَعة قبل جدولة التغطية لأي مزود.',
        }, { status: 409, headers })
      }
      if (ids.length) {
        const { data: selected, error: selectedError } = await db.from('contacts')
          .select('id').eq('account_id', ctx.accountId).in('id', ids).limit(ids.length)
        if (selectedError) throw selectedError
        if (selected?.length !== ids.length) {
          return NextResponse.json({ code: 'SCHEDULE_CONTACT_SCOPE_DENIED',
            error: 'جهة اتصال غير موجودة ضمن حسابك.' }, { status: 404, headers })
        }
      }
    }
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
    const { data: agent, error: agentError } = await db
      .from('ai_agents').select('id,published_revision_id,status')
      .eq('account_id', ctx.accountId).eq('id', definition.agentId).maybeSingle()
    if (agentError) throw agentError
    if (!agent || agent.status !== 'active' || !agent.published_revision_id) {
      return NextResponse.json({ error: 'الوكيل غير نشط أو لا يملك نسخة منشورة.', code: 'PUBLISHED_AGENT_REQUIRED' },
        { status: 409, headers })
    }
    if (definition.taskType === 'services.promotion' &&
        (definition.config.promotionReview as { approvedRevisionId?: string } | undefined)
          ?.approvedRevisionId !== agent.published_revision_id) {
      return NextResponse.json({ code: 'SCHEDULE_REVIEW_REVISION_CHANGED',
        error: 'تغيّرت نسخة الوكيل المنشورة بعد مراجعة الحملة.' },
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
