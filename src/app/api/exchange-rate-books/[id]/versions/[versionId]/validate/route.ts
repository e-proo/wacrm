// ============================================================
// /api/exchange-rate-books/[id]/versions/[versionId]/validate
// POST — dry-run the publish checks (RPC). Admin+ only.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { validateVersion } from '@/lib/services/rates/crud'

export async function POST(
  _request: Request,
  {
    params,
  }: { params: Promise<{ id: string; versionId: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:rateValidate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { id: bookId, versionId } = await params
    const result = await validateVersion(ctx.accountId, bookId, versionId)
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
