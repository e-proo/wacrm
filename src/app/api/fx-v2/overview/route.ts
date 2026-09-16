import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { getFxDashboardOverview } from '@/lib/services/fx-v2/dashboard'
import { toFxApiError } from '@/lib/services/fx-v2/http'

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const limit = checkRateLimit(
      `fx:overview:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const overview = await getFxDashboardOverview(ctx.accountId)
    return NextResponse.json({
      ...overview,
      canManage: hasMinRole(ctx.role, 'admin'),
    })
  } catch (err) {
    return toFxApiError(err)
  }
}
