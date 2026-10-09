import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { validateAgentRevisionForPublish } from '@/lib/ai/runtime/builder-service'
import { PublishError } from '@/lib/ai/runtime/agents-service'
import { publishAgentRevisionAtomic } from '@/lib/ai/runtime/atomic-publish'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; revisionId: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:agentRevisionPublish:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id, revisionId } = await params
    const validation = await validateAgentRevisionForPublish(ctx.supabase, {
      accountId: ctx.accountId,
      agentId: id,
      revisionId,
    })
    if (!validation.ok) return NextResponse.json(validation, { status: 409 })
    try {
      const agent = await publishAgentRevisionAtomic(ctx.supabase, {
        accountId: ctx.accountId,
        agentId: id,
        revisionId,
        actorUserId: ctx.userId,
      })
      return NextResponse.json({ agent, validation })
    } catch (err) {
      if (err instanceof PublishError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
      throw err
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
