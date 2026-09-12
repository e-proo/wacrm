// ============================================================
// /api/coverage/requests/[id] — lifecycle + draft edits for ONE
// coverage request. Admin+ only.
//
// PATCH body:
//   { action: 'activate' | 'cancel' | 'fulfill' | 'expire' }
//   or { patch: { ...draft fields } } — only while the request is
//   a pristine draft (nothing reserved / fulfilled).
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  patchCoverageRequestDraft,
  transitionCoverageRow,
  type CoverageAction,
  type RequestDraftPatch,
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
  patch?: RequestDraftPatch
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:coverageRequestPatch:${ctx.userId}`,
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
          table: 'coverage_requests',
          targetType: 'coverage_request',
        })
        return NextResponse.json({ ok: true })
      }

      if (body.patch) {
        const req = await patchCoverageRequestDraft(ctx.accountId, id, body.patch)
        return NextResponse.json({ request: req })
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
