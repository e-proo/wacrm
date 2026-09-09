import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getOperationalMetrics } from '@/lib/ai/runtime/operational-metrics'

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:aiMetrics:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const since = new URL(request.url).searchParams.get('since') ?? undefined
    return NextResponse.json(await getOperationalMetrics(ctx.accountId, since))
  } catch (err) {
    return toErrorResponse(err)
  }
}
