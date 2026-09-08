// ============================================================
// /api/change-requests/[id]/[action]
//
// Phase 3 actions:
//   approve  — admin supplies the confirmation code; record approval.
//   reject   — admin rejects; record rejection.
//   cancel   — admin cancels their own pending proposal.
//
// All admin+ only.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  approveChangeRequest,
  cancelChangeRequest,
  ChangeRequestError,
  rejectChangeRequest,
} from '@/lib/ai/runtime/change-requests-service'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:changeRequestAction:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { id, action } = await params

    try {
      if (action === 'approve') {
        let body: { confirmationCode?: string }
        try {
          body = (await request.json()) as { confirmationCode?: string }
        } catch {
          return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
        }
        if (!body.confirmationCode) {
          return NextResponse.json(
            { error: 'confirmationCode is required' },
            { status: 400 },
          )
        }
        const result = await approveChangeRequest({
          accountId: ctx.accountId,
          changeRequestId: id,
          confirmationCode: body.confirmationCode,
          actorUserId: ctx.userId,
        })
        return NextResponse.json(result)
      }
      if (action === 'reject') {
        let body: { reason?: string }
        try {
          body = (await request.json().catch(() => ({}))) as { reason?: string }
        } catch {
          body = {}
        }
        const result = await rejectChangeRequest({
          accountId: ctx.accountId,
          changeRequestId: id,
          actorUserId: ctx.userId,
          reason: body.reason ?? null,
        })
        return NextResponse.json(result)
      }
      if (action === 'cancel') {
        const result = await cancelChangeRequest({
          accountId: ctx.accountId,
          changeRequestId: id,
          actorUserId: ctx.userId,
        })
        return NextResponse.json(result)
      }
    } catch (innerErr) {
      if (innerErr instanceof ChangeRequestError) {
        return NextResponse.json(
          { error: innerErr.message, code: innerErr.code },
          { status: innerErr.status },
        )
      }
      throw innerErr
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 404 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
