// ============================================================
// /api/exchange-rates/current — public-safe rate lookup.
// Admin+ only for now (Phase 2); Phase 3 will add a dedicated
// scope for the AI tool.
//
// Reads the current published version of the matching book and
// returns either a `current` rate OR an `unavailable_stale`
// sentinel. Never returns a stale rate as if it were current —
// Phase 2's strict requirement.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { getCurrentExchangeRate } from '@/lib/services/domain-services'

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:rateCurrent:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const url = new URL(request.url)
    const baseCurrency = url.searchParams.get('base')
    const quoteCurrency = url.searchParams.get('quote')
    const intentRaw = url.searchParams.get('intent')
    const region = url.searchParams.get('region')
    const settlement = url.searchParams.get('settlement')
    if (!baseCurrency || !quoteCurrency) {
      return NextResponse.json(
        { error: 'base and quote are required' },
        { status: 400 },
      )
    }
    if (intentRaw !== 'customer_sells_base' && intentRaw !== 'customer_buys_base') {
      return NextResponse.json(
        { error: 'intent must be customer_sells_base or customer_buys_base' },
        { status: 400 },
      )
    }
    const result = await getCurrentExchangeRate({
      accountId: ctx.accountId,
      baseCurrency,
      quoteCurrency,
      intent: intentRaw,
      region,
      channel: 'whatsapp',
      settlementMethod: settlement,
    })
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
