// ============================================================
// /api/currencies/[id] — read/update/disable a single currency.
// Admin+ only.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  getCurrency,
  updateCurrency,
  ServiceError,
} from '@/lib/services/currencies/crud'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:currencyRead:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params
    const currency = await getCurrency(ctx.accountId, id)
    if (!currency) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json({ currency })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface PatchBody {
  code?: string
  displayName?: string
  notes?: string | null
  status?: 'active' | 'disabled'
  kind?: 'iso_4217' | 'historical' | 'local'
  decimalDigits?: number
  symbol?: string | null
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:currencyUpdate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    let body: PatchBody
    try {
      body = (await request.json()) as PatchBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    try {
      const currency = await updateCurrency(
        ctx.accountId,
        id,
        {
          code: body.code?.toUpperCase(),
          displayName: body.displayName,
          notes: body.notes,
          status: body.status,
          kind: body.kind,
          decimalDigits: body.decimalDigits,
          symbol: body.symbol,
        },
        ctx.userId,
      )
      return NextResponse.json({ currency })
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
