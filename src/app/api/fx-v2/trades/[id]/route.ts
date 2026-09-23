import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  cancelFxTradeRequest,
  completeFxTradeRequest,
  decideFxTradeRequest,
} from '@/lib/services/fx-v2/service'
import { toFxApiError } from '@/lib/services/fx-v2/http'
import { deliverActiveSubjectBusinessEventNotifications } from '@/lib/ai/runtime/customer-notification-delivery'

type TradeAction = 'approve' | 'reject' | 'complete' | 'cancel'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:fxTradeTransition:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { id: requestId } = await params
    const body = (await request.json().catch(() => ({}))) as {
      action?: TradeAction
      note?: string | null
      changeRequestId?: string | null
    }

    let result
    if (body.action === 'approve' || body.action === 'reject') {
      result = await decideFxTradeRequest({
        accountId: ctx.accountId,
        requestId,
        expectedStatus: 'pending_admin',
        decision: body.action,
        changeRequestId: body.changeRequestId ?? null,
        note: body.note ?? null,
        actorUserId: ctx.userId,
      })
    } else if (body.action === 'complete') {
      result = await completeFxTradeRequest({
        accountId: ctx.accountId,
        requestId,
        actorUserId: ctx.userId,
      })
    } else if (body.action === 'cancel') {
      result = await cancelFxTradeRequest({
        accountId: ctx.accountId,
        requestId,
        actorUserId: ctx.userId,
      })
    } else {
      return NextResponse.json(
        { error: 'action must be approve, reject, complete, or cancel' },
        { status: 400 },
      )
    }

    if (
      body.action === 'approve' ||
      body.action === 'reject' ||
      body.action === 'complete'
    ) {
      try {
        const delivery = await deliverActiveSubjectBusinessEventNotifications({
          accountId: ctx.accountId,
          subjectType: 'fx_trade_request',
          subjectId: requestId,
          correlationId:
            body.action === 'approve' || body.action === 'reject'
              ? body.changeRequestId ?? null
              : null,
          limit: 10,
        })
        if (
          delivery.failed > 0 ||
          delivery.reconciliation > 0
        ) {
          console.error(
            '[fx-v2 trade route] customer event delivery incomplete:',
            {
              requestId,
              action: body.action,
              delivery,
            },
          )
        }
      } catch (deliveryError) {
        // Business mutation is authoritative and already committed. Delivery is
        // durable/recoverable through the business-event worker, so transport
        // failure must not turn a successful mutation into an API failure.
        console.error(
          '[fx-v2 trade route] customer event delivery failed:',
          requestId,
          body.action,
          deliveryError,
        )
      }
    }

    return NextResponse.json(result)
  } catch (err) {
    return toFxApiError(err)
  }
}
