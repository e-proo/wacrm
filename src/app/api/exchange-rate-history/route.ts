// ============================================================
// /api/exchange-rate-history — read-only audit log.
// Admin+ only.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { getRateHistory } from '@/lib/services/rates/crud'

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:rateHistory:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const url = new URL(request.url)
    const bookId = url.searchParams.get('bookId') ?? undefined
    const baseCurrency = url.searchParams.get('base') ?? undefined
    const quoteCurrency = url.searchParams.get('quote') ?? undefined
    const from = url.searchParams.get('from') ?? undefined
    const to = url.searchParams.get('to') ?? undefined
    const limitParam = url.searchParams.get('limit')
    const rowLimit = limitParam ? Number(limitParam) : 200

    const rows = await getRateHistory({
      accountId: ctx.accountId,
      bookId,
      baseCurrency,
      quoteCurrency,
      from,
      to,
      limit: Number.isFinite(rowLimit) ? rowLimit : 200,
    })
    return NextResponse.json({ history: rows })
  } catch (err) {
    return toErrorResponse(err)
  }
}
