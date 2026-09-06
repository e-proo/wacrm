// ============================================================
// /api/activity-events — read-only audit feed.
// Admin+ only.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { listActivityEvents } from '@/lib/services/pricing/rules-crud'

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:activityEventsList:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const url = new URL(request.url)
    const targetType = url.searchParams.get('target_type') ?? undefined
    const limitParam = url.searchParams.get('limit')
    const rowLimit = limitParam ? Number(limitParam) : 200
    const events = await listActivityEvents({
      accountId: ctx.accountId,
      targetType,
      limit: Number.isFinite(rowLimit) ? rowLimit : 200,
    })
    return NextResponse.json({ events })
  } catch (err) {
    return toErrorResponse(err)
  }
}
