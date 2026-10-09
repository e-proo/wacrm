import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { listFxRateHistory } from '@/lib/services/fx-v2/dashboard'
import { toFxApiError } from '@/lib/services/fx-v2/http'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('viewer')
    const limit = checkRateLimit(
      `fx:history:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { id: pairId } = await params
    const url = new URL(request.url)
    const requestedLimit = Number(url.searchParams.get('limit') ?? '50')
    const history = await listFxRateHistory(
      ctx.accountId,
      pairId,
      Number.isFinite(requestedLimit) ? requestedLimit : 50,
    )
    return NextResponse.json({ history })
  } catch (err) {
    return toFxApiError(err)
  }
}
