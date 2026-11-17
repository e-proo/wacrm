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
      .in('task_type_version', [1, 2])
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

/** Legacy direct POST may not bypass the reviewed V2 campaign wizard. */
export async function POST() {
  try {
    await requireAgentCapability('agents.manage_tasks')
    await requireAgentCapability('agents.manage_outreach')
    return NextResponse.json({
      code: 'SERVICE_PROMOTION_REVIEW_REQUIRED',
      error: 'ابدأ من واجهة مهام الوكلاء، واختر خدمة ترويج وراجع الجمهور والجلسة ثم اعتمد المعاينة.',
    }, { status: 409, headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return toErrorResponse(error)
  }
}
