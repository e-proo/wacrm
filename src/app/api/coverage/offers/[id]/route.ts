// ============================================================
// /api/coverage/offers/[id] — lifecycle + draft edits for ONE
// coverage offer. Admin+ only.
//
// PATCH body:
//   { action: 'activate' | 'cancel' | 'fulfill' | 'expire' }
//   or { patch: { ...draft fields } } — only while the offer is a
//   pristine draft (nothing reserved / fulfilled).
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  patchCoverageOfferDraft,
  transitionCoverageRow,
  type CoverageAction,
  type OfferDraftPatch,
} from '@/lib/services/coverage/lifecycle'
import { ServiceError } from '@/lib/services/domain-services'

const ACTIONS: ReadonlySet<string> = new Set([
  'activate',
  'cancel',
  'fulfill',
  'expire',
])

interface PatchBody {
  action?: string
  patch?: OfferDraftPatch
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:coverageOfferPatch:${ctx.userId}`,
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
      if (body.action) {
        if (!ACTIONS.has(body.action)) {
          return NextResponse.json(
            { error: 'action must be activate, cancel, fulfill, or expire' },
            { status: 400 },
          )
        }
        await transitionCoverageRow({
          accountId: ctx.accountId,
          rowId: id,
          action: body.action as CoverageAction,
          actorUserId: ctx.userId,
          table: 'coverage_offers',
          targetType: 'coverage_offer',
        })
        return NextResponse.json({ ok: true })
      }

      if (body.patch) {
        const offer = await patchCoverageOfferDraft(ctx.accountId, id, body.patch)
        return NextResponse.json({ offer })
      }

      return NextResponse.json(
        { error: 'Provide either action or patch' },
        { status: 400 },
      )
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
