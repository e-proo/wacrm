import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { validateAgentRevisionForPublish } from '@/lib/ai/runtime/builder-service'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; revisionId: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:agentRevisionValidate:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id, revisionId } = await params
    const result = await validateAgentRevisionForPublish(ctx.supabase, {
      accountId: ctx.accountId,
      agentId: id,
      revisionId,
    })
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
