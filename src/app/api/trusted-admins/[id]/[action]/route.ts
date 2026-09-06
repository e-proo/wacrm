// ============================================================
// POST /api/trusted-admins/[id]/verify
// POST /api/trusted-admins/[id]/revoke
//
// verify  — admin submits the OTP; server hash-compares and flips
//           the identity to 'active' on success.
// revoke  — admin soft-revokes the identity. Rows stay for audit;
//           identity is no longer honored for routing.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  revokeTrustedAdmin,
  TrustedAdminError,
  verifyTrustedAdmin,
} from '@/lib/ai/runtime/trusted-admins-service'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  try {
    const ctx = await requireRole('admin')

    const limit = checkRateLimit(
      `admin:trustedAdminAction:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { id, action } = await params

    try {
      if (action === 'verify') {
        let body: { otp?: string }
        try {
          body = (await request.json()) as { otp?: string }
        } catch {
          return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
        }
        if (!body.otp) {
          return NextResponse.json(
            { error: 'otp is required' },
            { status: 400 },
          )
        }
        const identity = await verifyTrustedAdmin(ctx.supabase, {
          accountId: ctx.accountId,
          identityId: id,
          otp: body.otp,
          actorUserId: ctx.userId,
        })
        return NextResponse.json({ identity })
      }
      if (action === 'revoke') {
        const identity = await revokeTrustedAdmin(ctx.supabase, {
          accountId: ctx.accountId,
          identityId: id,
          actorUserId: ctx.userId,
        })
        return NextResponse.json({ identity })
      }
    } catch (innerErr) {
      if (innerErr instanceof TrustedAdminError) {
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
