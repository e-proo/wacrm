import { NextResponse } from 'next/server'
import { requireAgentCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
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
        .select('id,task_type,task_type_version,status,target_policy,max_targets,max_attempts_per_target,created_at,agent_id')
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
      })),
      coverageRequests: requests ?? [],
      tasks: (tasks ?? []).map((row) => ({
        id: row.id, taskType: row.task_type, version: row.task_type_version,
        status: row.status, agentId: row.agent_id,
        connectionId: record(row.target_policy) &&
          typeof row.target_policy.whatsappConnectionId === 'string'
          ? row.target_policy.whatsappConnectionId : null,
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
        !intInRange(body.maxTargets, 10000) ||
        !intInRange(body.maxAttemptsPerTarget, 20)) {
      return NextResponse.json({ error: 'بيانات التعديل غير صالحة.', code: 'INVALID_TASK_UPDATE' }, { status: 400 })
    }
    const db = supabaseAdmin()
    const { data, error } = await db.rpc('update_pending_agent_task_connection', {
      p_account_id: ctx.accountId,
      p_task_id: body.taskId,
      p_actor_user_id: ctx.userId,
      p_connection_id: body.whatsappConnectionId,
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
