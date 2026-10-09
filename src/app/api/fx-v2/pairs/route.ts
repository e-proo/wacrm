import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { ensureFxPair } from '@/lib/services/fx-v2/service'
import { toFxApiError } from '@/lib/services/fx-v2/http'

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:fxPairCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => ({}))) as {
      baseCode?: string
      quoteCode?: string
    }
    if (!body.baseCode || !body.quoteCode) {
      return NextResponse.json(
        { error: 'baseCode and quoteCode are required' },
        { status: 400 },
      )
    }

    const pair = await ensureFxPair(
      ctx.accountId,
      body.baseCode,
      body.quoteCode,
      ctx.userId,
    )
    return NextResponse.json({ pair })
  } catch (err) {
    return toFxApiError(err)
  }
}
