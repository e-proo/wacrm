// ============================================================
// /api/exchange-rate-books/[id]/versions — list + create draft
// versions for a book. Admin+ only.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  createDraftVersion,
  listVersions,
  ServiceError,
} from '@/lib/services/rates/crud'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:rateVersionsList:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { id: bookId } = await params
    const versions = await listVersions(ctx.accountId, bookId)
    return NextResponse.json({ versions })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:rateVersionCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { id: bookId } = await params

    let body: {
      effectiveAt?: string | null
      expiresAt?: string | null
    }
    try {
      body = (await request.json().catch(() => ({}))) as typeof body
    } catch {
      body = {}
    }
    try {
      const version = await createDraftVersion(
        ctx.accountId,
        bookId,
        {
          effectiveAt: body.effectiveAt ?? null,
          expiresAt: body.expiresAt ?? null,
        },
        ctx.userId,
      )
      return NextResponse.json({ version })
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
