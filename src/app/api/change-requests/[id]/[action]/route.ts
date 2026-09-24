import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  approveChangeRequest,
  cancelChangeRequest,
  ChangeRequestError,
  rejectChangeRequest,
} from '@/lib/ai/runtime/change-requests-service'
import {
  ChangeExecutionError,
  executeApprovedChangeRequest,
} from '@/lib/ai/runtime/change-request-executor'

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

        const approved = await approveChangeRequest({
          accountId: ctx.accountId,
          changeRequestId: id,
          confirmationCode: body.confirmationCode,
          actorUserId: ctx.userId,
        })

        // Approval is a business command, not merely a state toggle. Attempt
        // deterministic execution in the same API request. If the process dies
        // after approval but before this call, the recovery worker will pick up
        // the still-approved request. Claim/CAS keeps concurrent callers safe.
        if (approved.status === 'approved' || approved.status === 'executed') {
          try {
            const execution = await executeApprovedChangeRequest({
              accountId: ctx.accountId,
              changeRequestId: id,
              actorUserId: ctx.userId,
            })
            return NextResponse.json({ ...approved, execution })
          } catch (executionErr) {
            if (executionErr instanceof ChangeExecutionError) {
              return NextResponse.json(
                {
                  ...approved,
                  execution: {
                    status: 'failed',
                    error: executionErr.message,
                    code: executionErr.code,
                  },
                },
                { status: executionErr.status },
              )
            }
            throw executionErr
          }
        }
        return NextResponse.json(approved)
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
