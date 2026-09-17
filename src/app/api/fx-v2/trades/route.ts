import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  listFxTradeRequests,
  type FxTradeRequestStatus,
} from '@/lib/services/fx-v2/dashboard'
import { toFxApiError } from '@/lib/services/fx-v2/http'

const STATUSES = new Set<FxTradeRequestStatus>([
  'pending_admin',
  'approved_for_contact',
  'rejected',
  'completed',
  'cancelled',
])

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer')
    const limit = checkRateLimit(
      `fx:trades:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const url = new URL(request.url)
    const rawStatus = url.searchParams.get('status')
    const status =
      rawStatus && STATUSES.has(rawStatus as FxTradeRequestStatus)
        ? (rawStatus as FxTradeRequestStatus)
        : null
    const requestedLimit = Number(url.searchParams.get('limit') ?? '100')
    const trades = await listFxTradeRequests(ctx.accountId, {
      status,
      limit: Number.isFinite(requestedLimit) ? requestedLimit : 100,
    })
    return NextResponse.json({ trades })
  } catch (err) {
    return toFxApiError(err)
  }
}
