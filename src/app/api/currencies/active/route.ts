// ============================================================
// /api/currencies/active — returns only ACTIVE currencies, sorted
// by code. Lightweight payload suitable for dropdowns in the
// rate editor + pricing rule editor.
//
// Admin+ only (Phase 2 keeps the surface gated — the AI tool
// from Phase 3 will get its own scope).
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { listActiveCurrencies } from '@/lib/services/currencies/active-list'

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:currenciesActive:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const currencies = await listActiveCurrencies(ctx.accountId)
    return NextResponse.json({ currencies })
  } catch (err) {
    return toErrorResponse(err)
  }
}
