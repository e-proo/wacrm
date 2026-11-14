import { NextResponse } from 'next/server'
import { requireAgentCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { checkCoverageSelectedContactEligibility } from '@/lib/services/coverage/selected-contact'
import {
  MAX_EXPLICIT_COVERAGE_CONTACTS,
  normalizeExplicitCoverageContactIds,
} from '@/lib/services/coverage/selected-targets'
import {
  CoverageSourcingTaskError,
  startCoverageSourcingTask,
} from '@/lib/services/coverage/agent-task-service'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const allowedStatus = new Set(['ready', 'connected'])
const isUUID = (value: unknown): value is string =>
  typeof value === 'string' && UUID_RE.test(value)
const intInRange = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const validSelectedContacts = (body: Record<string, unknown>): boolean => {
  try {
    return normalizeExplicitCoverageContactIds(body) !== null ||
      (body.selectedContactId == null && body.selectedContactIds == null)
  } catch { return false }
}

/**
 * Per-TASK WhatsApp connection picker.
 *
 * Client never sees gateway URL, API keys, secrets or OpenWA engine credentials.
 * All queries are account-scoped AFTER agents.manage_tasks authorization.
 */
export async function GET() {
  try {
    const ctx = await requireAgentCapability('agents.manage_tasks')
    const db = supabaseAdmin()
    const [
      { data: connections, error: connectionsError },
      { data: agents, error: agentsError },
      { data: requests, error: requestsError },
      { data: tasks, error: tasksError },
      { data: runtime, error: runtimeError },
    ] = await Promise.all([
      db.from('whatsapp_connections')
        .select('id,provider,status,archived_at,display_name,session_id')
        .eq('account_id', ctx.accountId)
        .order('updated_at', { ascending: false }).limit(100),
      db.from('ai_agents')
        .select('id,name,slug,status,published_revision_id')
        .eq('account_id', ctx.accountId)
        .order('created_at', { ascending: false }).limit(100),
      db.from('coverage_requests')
        .select('id,requested_amount,currency,status')
        .eq('account_id', ctx.accountId)
        .in('status', ['active','partially_reserved'])
        .order('created_at', { ascending: false }).limit(100),
      db.from('ai_agent_tasks')
        .select('id,task_type,task_type_version,status,target_policy,task_context,max_targets,max_attempts_per_target,created_at,agent_id')
        .eq('account_id', ctx.accountId)
        .order('created_at', { ascending: false }).limit(80),
      db.from('ai_runtime_policies')
        .select('outbound_task_delivery_enabled')
        .eq('account_id', ctx.accountId).maybeSingle(),
    ])
    if (connectionsError || agentsError || requestsError || tasksError || runtimeError) {
      throw connectionsError ?? agentsError ?? requestsError ?? tasksError ?? runtimeError
    }
    // Only disclose the Task Type versions authorized by each published
    // revision, never the full revision policy/tool grants/credentials.
    const revisionIds = (agents ?? [])
      .filter((agent) => typeof agent.published_revision_id === 'string')
      .map((agent) => agent.published_revision_id as string)
    let publishedRevisions: Array<{ id: string; outreach_policy: unknown }> = []
    if (revisionIds.length > 0) {
      const { data: revisions, error: revisionError } = await db
        .from('ai_agent_revisions')
        .select('id,outreach_policy')
        .eq('account_id', ctx.accountId)
        .eq('status', 'published')
        .in('id', revisionIds)
      if (revisionError) throw revisionError
      publishedRevisions = revisions ?? []
    }
    const versionsByRevision = new Map<string, number[]>()
    const maxByRevision = new Map<string, number>()
    for (const revision of publishedRevisions) {
      const policy = record(revision.outreach_policy) ? revision.outreach_policy : {}
      const values = Array.isArray(policy.bindings) ? policy.bindings : []
      const versions = values
        .filter(record)
        .filter((binding) =>
          binding.taskType === 'coverage.sourcing' &&
          (binding.taskTypeVersion === 1 || binding.taskTypeVersion === 2))
        .map((binding) => binding.taskTypeVersion as number)
      versionsByRevision.set(revision.id, versions)
      const preferredVersion = versions.includes(2) ? 2 : 1
      const limits = values.filter(record).filter(binding =>
        binding.taskType === 'coverage.sourcing' &&
        binding.taskTypeVersion === preferredVersion)
        .map(binding => Number(binding.maxTargets))
        .filter(value => Number.isInteger(value) && value >= 1)
      maxByRevision.set(revision.id,
        Math.min(MAX_EXPLICIT_COVERAGE_CONTACTS, ...(limits.length ? limits : [1])))
    }
    return NextResponse.json({
      connections: (connections ?? []).map((row) => ({
        id: row.id,
        provider: row.provider,
        status: row.status,
        name: row.display_name ?? (row.provider === 'openwa' ? 'OpenWA' : 'Meta Cloud'),
        archived: Boolean(row.archived_at),
        ready: !row.archived_at && allowedStatus.has(row.status) &&
          (row.provider === 'meta_cloud' ||
            (row.provider === 'openwa' && Boolean(row.session_id))),
      })),
      agents: (agents ?? []).map((row) => ({
        id: row.id, name: row.name, slug: row.slug,
        status: row.status, published: Boolean(row.published_revision_id),
        coverageVersions: row.published_revision_id
          ? versionsByRevision.get(row.published_revision_id) ?? [] : [],
        maxManualTargets: row.published_revision_id
          ? maxByRevision.get(row.published_revision_id) ?? 1 : 1,
      })),
      coverageRequests: requests ?? [],
      tasks: (tasks ?? []).map((row) => ({
        id: row.id, taskType: row.task_type, version: row.task_type_version,
        status: row.status, agentId: row.agent_id,
        connectionId: record(row.target_policy) &&
          typeof row.target_policy.whatsappConnectionId === 'string'
          ? row.target_policy.whatsappConnectionId : null,
        selectedContactId: record(row.target_policy) &&
          typeof row.target_policy.selectedContactId === 'string'
          ? row.target_policy.selectedContactId : null,
        selectedContactIds: record(row.target_policy) &&
          Array.isArray(row.target_policy.selectedContactIds)
          ? row.target_policy.selectedContactIds : record(row.target_policy) &&
            typeof row.target_policy.selectedContactId === 'string'
              ? [row.target_policy.selectedContactId] : [],
        coverageRequestId: record(row.task_context) &&
          typeof row.task_context.coverageRequestId === 'string'
          ? row.task_context.coverageRequestId : null,
        maxTargets: row.max_targets,
        maxAttemptsPerTarget: row.max_attempts_per_target,
        createdAt: row.created_at,
      })),
      outboundDeliveryEnabled: runtime?.outbound_task_delivery_enabled === true,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/** Create a bounded manual Coverage Task using the existing domain service.
 * The service validates the frozen agent revision, Builder grants, business
 * snapshot and cutover gates before writing through create_ai_agent_task.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireAgentCapability('agents.manage_tasks')
    const body: unknown = await request.json().catch(() => null)
    if (!record(body) || !isUUID(body.agentId) ||
        !isUUID(body.coverageRequestId) ||
        !(body.whatsappConnectionId === null || isUUID(body.whatsappConnectionId)) ||
        !validSelectedContacts(body) ||
        (Array.isArray(body.selectedContactIds) &&
          body.maxTargets !== body.selectedContactIds.length) ||
        (typeof body.selectedContactId === 'string' && body.maxTargets !== 1) ||
        !intInRange(body.maxTargets, 100) ||
        !intInRange(body.maxAttemptsPerTarget, 20)) {
      return NextResponse.json({ error: 'بيانات المهمة أو الاتصال غير صالحة.', code: 'INVALID_TASK_INPUT' }, { status: 400 })
    }
    const result = await startCoverageSourcingTask({
      accountId: ctx.accountId,
      agentId: body.agentId,
      coverageRequestId: body.coverageRequestId,
      actorUserId: ctx.userId,
      whatsappConnectionId: body.whatsappConnectionId,
      ...(body.selectedContactId ? { selectedContactId: body.selectedContactId as string } : {}),
      ...(Array.isArray(body.selectedContactIds)
        ? { selectedContactIds: body.selectedContactIds as string[] } : {}),
      maxTargets: body.maxTargets,
      maxAttemptsPerTarget: body.maxAttemptsPerTarget,
    })
    return NextResponse.json(result, { status: result.created ? 201 : 200 })
  } catch (error) {
    if (error instanceof CoverageSourcingTaskError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    return toErrorResponse(error)
  }
}

/** Update an already-created Task's *pending* route, never Agent defaults.
 * The service-only SQL RPC is the authority; it serializes with the worker
 * and refuses changes once a target/run/send exists.
 */
export async function PATCH(request: Request) {
  try {
    const ctx = await requireAgentCapability('agents.manage_tasks')
    const body: unknown = await request.json().catch(() => null)
    if (!record(body) || !isUUID(body.taskId) ||
        !(body.whatsappConnectionId === null || isUUID(body.whatsappConnectionId)) ||
        !validSelectedContacts(body) ||
        !(body.selectedContactId === null || body.selectedContactId === undefined || isUUID(body.selectedContactId)) ||
        !intInRange(body.maxTargets, 10000) ||
        !intInRange(body.maxAttemptsPerTarget, 20)) {
      return NextResponse.json({ error: 'بيانات التعديل غير صالحة.', code: 'INVALID_TASK_UPDATE' }, { status: 400 })
    }
    const db = supabaseAdmin()
    // Verify every explicitly selected contact's Coverage supplier eligibility
    // using tenant-scoped domain history before any pending Task mutation.
    // The SQL RPC independently re-checks admin, tenant, source identifiers,
    // frozen caps and the absence of Targets/Runs/reservations under a lock.
    let selectedIds: readonly string[] | null
    try {
      selectedIds = normalizeExplicitCoverageContactIds(body)
    } catch {
      return NextResponse.json({ error: 'حدد جهات اتصال صالحة دون تكرار.', code: 'INVALID_CONTACT_SELECTION' }, { status: 400 })
    }
    if (selectedIds && body.maxTargets !== selectedIds.length) {
      return NextResponse.json({ error: 'عدد المستهدفين يجب أن يساوي عدد الأرقام المحددة.', code: 'CONTACT_TARGET_COUNT_MISMATCH' }, { status: 400 })
    }
    if (selectedIds) {
      const { data: task, error: taskError } = await db.from('ai_agent_tasks')
        .select('task_type,task_context,target_policy')
        .eq('account_id', ctx.accountId)
        .eq('id', body.taskId).maybeSingle()
      if (taskError) throw taskError
      if (!task || task.task_type !== 'coverage.sourcing' ||
          !record(task.task_context) ||
          !isUUID(task.task_context.coverageRequestId)) {
        return NextResponse.json({ error: 'تعذّر التحقق من سياق المهمة.', code: 'TASK_CONTEXT_INVALID' }, { status: 409 })
      }
      const original = record(task.target_policy) ? task.target_policy : {}
      const regions = Array.isArray(original.coverageRegionIds) &&
        original.coverageRegionIds.every(isUUID) ? original.coverageRegionIds as string[] : []
      for (const contactId of selectedIds) {
        const eligibility = await checkCoverageSelectedContactEligibility(db, {
          accountId: ctx.accountId,
          coverageRequestId: task.task_context.coverageRequestId,
          contactId,
          coverageRegionIds: regions,
        })
        if (!eligibility.eligible) {
          return NextResponse.json({
            error: 'إحدى جهات الاتصال غير مؤهلة لهذا الطلب أو لا تتبع الحساب.',
            code: 'COVERAGE_CONTACT_NOT_ELIGIBLE',
          }, { status: 409 })
        }
      }
    }
    const multiple = Array.isArray(body.selectedContactIds)
    const { data, error } = multiple
      ? await db.rpc('update_pending_agent_task_targets', {
        p_account_id: ctx.accountId,
        p_task_id: body.taskId,
        p_actor_user_id: ctx.userId,
        p_connection_id: body.whatsappConnectionId,
        p_selected_contact_ids: selectedIds,
        p_max_targets: body.maxTargets,
        p_max_attempts_per_target: body.maxAttemptsPerTarget,
      })
      : await db.rpc('update_pending_agent_task_target', {
        p_account_id: ctx.accountId,
        p_task_id: body.taskId,
        p_actor_user_id: ctx.userId,
        p_connection_id: body.whatsappConnectionId,
        p_selected_contact_id: body.selectedContactId ?? null,
        p_max_targets: body.maxTargets,
        p_max_attempts_per_target: body.maxAttemptsPerTarget,
      })
    if (error) throw error
    if (!record(data) || data.updated !== true) {
      return NextResponse.json({
        error: 'لا يمكن تعديل الجلسة أو الحدود بعد بدء المهمة أو عند عدم جاهزية الاتصال.',
        code: record(data) && typeof data.reason === 'string' ? data.reason : 'TASK_UPDATE_DENIED',
      }, { status: 409 })
    }
    return NextResponse.json({ ok: true, task: data })
  } catch (error) {
    return toErrorResponse(error)
  }
}
