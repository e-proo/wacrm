import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { publishFxRateVersion } from '@/lib/services/fx-v2/service'
import { toFxApiError } from '@/lib/services/fx-v2/http'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:fxRatePublish:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { id: pairId } = await params
    const body = (await request.json().catch(() => ({}))) as {
      expectedLockVersion?: number
      businessBuyRate?: string
      businessSellRate?: string
      notesInternal?: string | null
    }
    if (
      body.expectedLockVersion === undefined ||
      !body.businessBuyRate ||
      !body.businessSellRate
    ) {
      return NextResponse.json(
        {
          error:
            'expectedLockVersion, businessBuyRate and businessSellRate are required',
        },
        { status: 400 },
      )
    }

    const result = await publishFxRateVersion({
      accountId: ctx.accountId,
      pairId,
      expectedLockVersion: body.expectedLockVersion,
      businessBuyRate: body.businessBuyRate,
      businessSellRate: body.businessSellRate,
      source: 'manual',
      notesInternal: body.notesInternal ?? null,
      actorUserId: ctx.userId,
    })
    return NextResponse.json(result)
  } catch (err) {
    return toFxApiError(err)
  }
}
