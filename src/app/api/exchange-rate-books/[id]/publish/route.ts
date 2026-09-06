// ============================================================
// /api/exchange-rate-books/[id]/publish — atomically publish a
// draft version (via the SQL RPC from migration 049).
// Admin+ only.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  publishExchangeRateVersion,
  ServiceError,
} from '@/lib/services/domain-services'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:ratePublish:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { id: bookId } = await params

    let body: { versionId?: string }
    try {
      body = (await request.json().catch(() => ({}))) as { versionId?: string }
    } catch {
      body = {}
    }
    if (!body.versionId) {
      return NextResponse.json(
        { error: 'versionId is required' },
        { status: 400 },
      )
    }

    try {
      const result = await publishExchangeRateVersion({
        accountId: ctx.accountId,
        bookId,
        versionId: body.versionId,
        actorUserId: ctx.userId,
      })
      return NextResponse.json(result)
    } catch (err) {
      if (err instanceof ServiceError) {
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.status },
        )
      }
      throw err
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
