import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { setFxBaseCurrency } from '@/lib/services/fx-v2/service'
import { toFxApiError } from '@/lib/services/fx-v2/http'

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:fxSettings:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => ({}))) as {
      currencyCode?: string
    }
    if (!body.currencyCode) {
      return NextResponse.json(
        { error: 'currencyCode is required' },
        { status: 400 },
      )
    }

    const currency = await setFxBaseCurrency(
      ctx.accountId,
      body.currencyCode,
      ctx.userId,
    )
    return NextResponse.json({ baseCurrency: currency })
  } catch (err) {
    return toFxApiError(err)
  }
}
