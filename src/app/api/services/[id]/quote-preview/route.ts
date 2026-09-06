// ============================================================
// /api/services/[id]/quote-preview — preview a fee without
// persisting anything. Admin+ only (Phase 2 keeps quotes a
// manual operator surface; customer-facing quotes land in
// Phase 3 alongside the agent tool).
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  previewServiceQuote,
  ServiceError,
} from '@/lib/services/domain-services'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:serviceQuote:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { id: serviceId } = await params

    let body: { amount?: string; currency?: string; attributes?: Record<string, unknown> }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (!body.amount || !body.currency) {
      return NextResponse.json(
        { error: 'amount and currency are required' },
        { status: 400 },
      )
    }

    try {
      const quote = await previewServiceQuote({
        accountId: ctx.accountId,
        serviceId,
        amount: body.amount,
        currency: body.currency,
        attributes: body.attributes ?? {},
      })
      return NextResponse.json({ quote })
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
