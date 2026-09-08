import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { ChangeExecutionError, executeApprovedChangeRequest } from '@/lib/ai/runtime/change-request-executor'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:changeRequestExecute:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params
    try {
      const result = await executeApprovedChangeRequest({ accountId: ctx.accountId, changeRequestId: id, actorUserId: ctx.userId })
      return NextResponse.json(result)
    } catch (err) {
      if (err instanceof ChangeExecutionError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
      throw err
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
