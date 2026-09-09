// ============================================================
// PATCH /api/customer-intents/[id] — update intent status /
// summary / matched service. Admin+ only.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  IntentError,
  updateIntent,
} from '@/lib/services/intents/intents-service'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:intentUpdate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    let body: {
      status?: 'new' | 'clarifying' | 'forwarded_to_admin' | 'fulfilled' | 'rejected' | 'matched'
      matchedServiceId?: string | null
      summary?: string | null
    }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    try {
      const intent = await updateIntent(
        ctx.accountId,
        id,
        {
          status: body.status,
          matchedServiceId: body.matchedServiceId,
          summary: body.summary,
        },
        ctx.userId,
      )
      return NextResponse.json({ intent })
    } catch (err) {
      if (err instanceof IntentError) {
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
