// ============================================================
// /api/currencies — list + create currencies for the account.
// Reads: any account member. Writes: admin+ only.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  createCurrency,
  listCurrencies,
  ServiceError,
} from '@/lib/services/currencies/crud'

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const limit = checkRateLimit(
      `currenciesList:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const currencies = await listCurrencies(ctx.accountId)
    return NextResponse.json({ currencies })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface CreateBody {
  code: string
  displayName: string
  notes?: string | null
  status?: 'active' | 'disabled'
  kind?: 'iso_4217' | 'historical' | 'local'
  decimalDigits?: number
  symbol?: string | null
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:currencyCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    let body: CreateBody
    try {
      body = (await request.json()) as CreateBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (!body.code || !body.displayName) {
      return NextResponse.json(
        { error: 'code and displayName are required' },
        { status: 400 },
      )
    }
    try {
      const currency = await createCurrency(
        ctx.accountId,
        {
          code: body.code.toUpperCase(),
          displayName: body.displayName,
          notes: body.notes ?? null,
          status: body.status ?? 'active',
          kind: body.kind ?? 'iso_4217',
          decimalDigits: body.decimalDigits ?? 2,
          symbol: body.symbol ?? null,
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
