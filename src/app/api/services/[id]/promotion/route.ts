import { NextResponse } from 'next/server'
import {
  requireAgentCapability,
  toErrorResponse,
} from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  ServicePromotionTaskError,
  startServicePromotionTask,
} from '@/lib/services/service-catalog/agent-task-service'

const ACTIVE_TASK_STATUSES = [
  'validating',
  'scheduled',
  'queued',
  'running',
  'paused',
] as const

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireAgentCapability('agents.read')
    const limit = checkRateLimit(
      `admin:servicePromotionRead:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const { data, error } = await ctx.supabase
      .from('ai_agent_tasks')
      .select(
        'id, task_type, task_type_version, agent_id, agent_revision_id, status, objective, max_targets, max_attempts_per_target, task_context, created_at, started_at, completed_at',
      )
      .eq('account_id', ctx.accountId)
      .eq('task_type', 'services.promotion')
      .eq('task_type_version', 1)
      .contains('task_context', { serviceId: id })
      .order('created_at', { ascending: false })
      .limit(20)
    if (error) throw error

    return NextResponse.json({
      tasks: data ?? [],
      activeTask:
        (data ?? []).find((task) =>
          ACTIVE_TASK_STATUSES.includes(
            task.status as (typeof ACTIVE_TASK_STATUSES)[number],
          ),
        ) ?? null,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireAgentCapability('agents.manage_tasks')
    const limit = checkRateLimit(
      `admin:servicePromotionStart:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = (await request.json().catch(() => null)) as {
      agentId?: unknown
    } | null
    if (!body || typeof body.agentId !== 'string' || !body.agentId.trim()) {
      return NextResponse.json(
        { error: 'agentId is required', code: 'SERVICE_PROMOTION_AGENT_REQUIRED' },
        { status: 400 },
      )
    }

    const result = await startServicePromotionTask({
      accountId: ctx.accountId,
      serviceId: id,
      agentId: body.agentId.trim(),
      actorUserId: ctx.userId,
    })
    return NextResponse.json(
      {
        task: {
          id: result.taskId,
          agentId: result.agentId,
          revisionId: result.revisionId,
        },
        created: result.created,
      },
      { status: result.created ? 201 : 200 },
    )
  } catch (error) {
    if (error instanceof ServicePromotionTaskError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      )
    }
    return toErrorResponse(error)
  }
}
