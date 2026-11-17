import { NextResponse } from 'next/server'
import { requireAgentCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'
import { ServicePromotionTaskError, startServicePromotionTask } from '@/lib/services/service-catalog/agent-task-service'
import { ServicePromotionReviewError } from '@/lib/services/service-catalog/promotion-campaign-review'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store, max-age=0' }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Listing is a read-only picker. It never includes provider secrets or prompts. */
export async function GET() {
  try {
    const ctx = await requireAgentCapability('agents.manage_tasks')
    await requireAgentCapability('agents.manage_outreach')
    const db = supabaseAdmin()
    const [{ data: services, error: se }, { data: agents, error: ae },
      { data: connections, error: ce }, { data: tasks, error: te },
      { data: tags, error: ge }] = await Promise.all([
      db.from('services').select('id,name,code,status').eq('account_id', ctx.accountId)
        .eq('status', 'active').order('name', { ascending: true }).limit(100),
      db.from('ai_agents').select('id,name,status,published_revision_id')
        .eq('account_id', ctx.accountId).eq('status', 'active')
        .order('name', { ascending: true }).limit(100),
      db.from('whatsapp_connections')
        .select('id,display_name,provider,status,session_id,archived_at')
        .eq('account_id', ctx.accountId).order('updated_at', { ascending: false }).limit(100),
      db.from('ai_agent_tasks')
        .select('id,status,task_context,task_type_version,created_at')
        .eq('account_id', ctx.accountId).eq('task_type', 'services.promotion')
        .order('created_at', { ascending: false }).limit(50),
      db.from('tags').select('id,name,color').eq('account_id', ctx.accountId)
        .order('name', { ascending: true }).limit(200),
    ])
    if (se || ae || ce || te || ge) throw se ?? ae ?? ce ?? te ?? ge
    const ids = (agents ?? []).map(row => row.published_revision_id)
      .filter((value): value is string => typeof value === 'string')
    let revisions: Array<{ id: string; outreach_policy: unknown }> = []
    if (ids.length > 0) {
      const { data, error } = await db.from('ai_agent_revisions')
        .select('id,outreach_policy')
        .eq('account_id', ctx.accountId).eq('status', 'published')
        .in('id', ids).limit(ids.length)
      if (error) throw error
      revisions = data ?? []
    }
    const bindingsByRevision = new Map<string, boolean>()
    for (const rev of revisions) {
      const policy = rev.outreach_policy
      const bindings = policy && typeof policy === 'object' && !Array.isArray(policy)
        ? (policy as Record<string, unknown>).bindings : undefined
      bindingsByRevision.set(rev.id, Array.isArray(bindings) && bindings.some(b =>
        b && typeof b === 'object' && b.taskType === 'services.promotion' &&
        b.taskTypeVersion === 2))
    }
    const launchEnabled = isOpenWATestProject() &&
      process.env.WACRM_SERVICE_PROMOTION_PILOT_ALLOW_LIVE === '1'
    return NextResponse.json({
      services: services ?? [],
      tags: tags ?? [],
      agents: (agents ?? []).map(a => ({ id: a.id, name: a.name,
        published: Boolean(a.published_revision_id),
        promotionV2: typeof a.published_revision_id === 'string' &&
          bindingsByRevision.get(a.published_revision_id) === true })),
      connections: (connections ?? []).map(c => ({
        id: c.id, name: c.display_name || (c.provider === 'openwa' ? 'OpenWA' : 'Meta Cloud'),
        provider: c.provider,
        ready: !c.archived_at && (c.provider === 'meta_cloud' && c.status === 'connected' ||
          c.provider === 'openwa' && ['ready', 'connected'].includes(c.status) &&
            Boolean(c.session_id)),
        status: c.status,
      })),
      recentTasks: (tasks ?? []).map(task => ({
        id: task.id, status: task.status, version: task.task_type_version,
        serviceId: task.task_context && typeof task.task_context === 'object' &&
          !Array.isArray(task.task_context)
          ? (task.task_context as Record<string, unknown>).serviceId : null,
        createdAt: task.created_at,
      })),
      launchEnabled,
      mode: launchEnabled ? 'test_operator_only' : 'preview_only',
    }, { headers })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/**
 * Launch remains TEST-only + feature-gated until SP-6 technical acceptance.
 * A reviewed, fresh, exact cohort and explicit admin consent attestation are
 * required; the server rechecks all fields before the only Task-creation RPC.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAgentCapability('agents.manage_tasks')
    await requireAgentCapability('agents.manage_outreach')
    const rate = checkRateLimit('admin:servicePromotionLaunch:' + ctx.userId, RATE_LIMITS.adminAction)
    if (!rate.success) return rateLimitResponse(rate)
    if (!isOpenWATestProject() ||
        process.env.WACRM_SERVICE_PROMOTION_PILOT_ALLOW_LIVE !== '1') {
      return NextResponse.json({
        code: 'SERVICE_PROMOTION_LIVE_ACCEPTANCE_NOT_AUTHORIZED',
        error: 'إنشاء مهمة ترويج حي موقوف حتى إكمال الاختبارات التقنية واعتماد Pilot على TEST.',
      }, { status: 403, headers })
    }
    const raw: unknown = await request.json().catch(() => null)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return NextResponse.json({ code: 'SERVICE_PROMOTION_INVALID_INPUT',
        error: 'البيانات غير صالحة.' }, { status: 400, headers })
    }
    const body = raw as Record<string, unknown>
    if (typeof body.serviceId !== 'string' || !UUID_RE.test(body.serviceId) ||
        typeof body.agentId !== 'string' || !UUID_RE.test(body.agentId) ||
        typeof body.connectionId !== 'string' || !UUID_RE.test(body.connectionId) ||
        typeof body.submissionId !== 'string' || !UUID_RE.test(body.submissionId) ||
        typeof body.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.fingerprint) ||
        typeof body.reviewedAt !== 'string' || body.reviewedAt.length > 64 ||
        body.consentAcknowledged !== true || body.approvalAcknowledged !== true ||
        Object.prototype.hasOwnProperty.call(body, 'targetContactIds')) {
      return NextResponse.json({ code: 'SERVICE_PROMOTION_INVALID_INPUT',
        error: 'يجب معاينة الجمهور واختيار الاتصال والموافقة عليهما صراحةً.' },
      { status: 400, headers })
    }

    const result = await startServicePromotionTask({
      accountId: ctx.accountId,
      serviceId: body.serviceId,
      agentId: body.agentId,
      actorUserId: ctx.userId,
      review: { connectionId: body.connectionId, fingerprint: body.fingerprint,
        reviewedAt: body.reviewedAt, submissionId: body.submissionId,
        consentAcknowledged: true, approvalAcknowledged: true },
    })
    return NextResponse.json({
      task: { id: result.taskId, revisionId: result.revisionId, agentId: result.agentId },
      created: result.created,
    }, { status: result.created ? 201 : 200, headers })
  } catch (error) {
    if (error instanceof ServicePromotionTaskError ||
        error instanceof ServicePromotionReviewError) {
      return NextResponse.json({ error: error.message, code: error.code },
        { status: error.status, headers })
    }
    return toErrorResponse(error)
  }
}
