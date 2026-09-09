// ============================================================
// /api/coverage/matches — atomic booking (POST) + release (DELETE).
// Admin+ only.
//
// Booking goes through the `reserve_coverage_match` SQL RPC
// (migration 050) so the offer/request row locks happen in a
// single transaction. Two concurrent callers racing for the last
// unit of availability must result in exactly one success.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  releaseCoverageMatch,
  reserveCoverageMatch,
  ServiceError,
} from '@/lib/services/domain-services'

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:coverageMatchesList:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { data, error } = await ctx.supabase
      .from('coverage_matches')
      .select(
        'id, account_id, offer_id, request_id, service_id, matched_amount, currency, status, created_at',
      )
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
    if (error) {
      console.error('[GET /api/coverage/matches] error:', error)
      return NextResponse.json(
        { error: 'Failed to list matches' },
        { status: 500 },
      )
    }
    return NextResponse.json({ matches: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface CreateMatchBody {
  offerId: string
  requestId: string
  matchedAmount: string
  currency: string
  idempotencyKey: string
  reservedUntil?: string | null
  rateSnapshot?: Record<string, unknown>
  feeSnapshot?: Record<string, unknown>
  providerCost?: string | null
  customerFee?: string | null
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:coverageMatchCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    let body: CreateMatchBody
    try {
      body = (await request.json()) as CreateMatchBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (!body.offerId || !body.requestId || !body.currency || !body.idempotencyKey) {
      return NextResponse.json(
        { error: 'offerId, requestId, currency, idempotencyKey are required' },
        { status: 400 },
      )
    }
    try {
      const result = await reserveCoverageMatch({
        accountId: ctx.accountId,
        offerId: body.offerId,
        requestId: body.requestId,
        matchedAmount: body.matchedAmount,
        currency: body.currency,
        idempotencyKey: body.idempotencyKey,
        reservedUntil: body.reservedUntil ?? null,
        rateSnapshot: body.rateSnapshot ?? {},
        feeSnapshot: body.feeSnapshot ?? {},
        providerCost: body.providerCost ?? null,
        customerFee: body.customerFee ?? null,
        actorUserId: ctx.userId,
      })
      return NextResponse.json(result)
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

interface ReleaseBody {
  matchId: string
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:coverageMatchRelease:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    let body: ReleaseBody
    try {
      body = (await request.json()) as ReleaseBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (!body.matchId) {
      return NextResponse.json({ error: 'matchId required' }, { status: 400 })
    }
    try {
      await releaseCoverageMatch({
        accountId: ctx.accountId,
        matchId: body.matchId,
        actorUserId: ctx.userId,
      })
      return NextResponse.json({ ok: true })
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
