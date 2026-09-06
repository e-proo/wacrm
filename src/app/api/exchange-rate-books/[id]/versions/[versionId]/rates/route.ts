// ============================================================
// /api/exchange-rate-books/[id]/versions/[versionId]/rates
// GET   — list rates in a version.
// PUT   — REPLACE all rates in a draft version.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  listRatesForVersion,
  putVersionRates,
  ServiceError,
} from '@/lib/services/rates/crud'

export async function GET(
  _request: Request,
  {
    params,
  }: { params: Promise<{ id: string; versionId: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:rateList:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { versionId } = await params
    const rates = await listRatesForVersion(ctx.accountId, versionId)
    return NextResponse.json({ rates })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface PutBody {
  rates: Array<{
    baseCurrency: string
    quoteCurrency: string
    buyRate: string
    sellRate: string
    minAmount?: string | null
    maxAmount?: string | null
    rateUnit?: string | null
  }>
}

export async function PUT(
  request: Request,
  {
    params,
  }: { params: Promise<{ id: string; versionId: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:ratePut:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { id: bookId, versionId } = await params

    let body: PutBody
    try {
      body = (await request.json()) as PutBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (!Array.isArray(body.rates)) {
      return NextResponse.json(
        { error: 'rates must be an array' },
        { status: 400 },
      )
    }
    try {
      const rates = await putVersionRates(
        ctx.accountId,
        bookId,
        versionId,
        body.rates,
      )
      return NextResponse.json({ rates })
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
