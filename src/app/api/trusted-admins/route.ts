// ============================================================
// GET  /api/trusted-admins        — list identities for the account
// POST /api/trusted-admins        — register a new identity, returns
//                                    { identity, otp } where the OTP
//                                    must be delivered out-of-band
//                                    (Phase 1: the UI shows it on
//                                    the same screen).
//
// Both endpoints require admin+.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  listTrustedAdmins,
  registerTrustedAdmin,
  TrustedAdminError,
} from '@/lib/ai/runtime/trusted-admins-service'

export async function GET() {
  try {
    const ctx = await requireRole('admin')

    const limit = checkRateLimit(
      `admin:trustedAdminsList:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const identities = await listTrustedAdmins(ctx.supabase, ctx.accountId)
    return NextResponse.json({ identities })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface RegisterBody {
  phone: string
  displayName?: string | null
  memberId?: string | null
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const limit = checkRateLimit(
      `admin:trustedAdminRegister:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    let body: RegisterBody
    try {
      body = (await request.json()) as RegisterBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (!body.phone) {
      return NextResponse.json(
        { error: 'phone is required' },
        { status: 400 },
      )
    }

    try {
      const result = await registerTrustedAdmin(ctx.supabase, {
        accountId: ctx.accountId,
        rawPhone: body.phone,
        displayName: body.displayName ?? null,
        memberId: body.memberId ?? null,
        actorUserId: ctx.userId,
      })
      // The OTP is shown to the admin in the response and is
      // meant to be delivered out-of-band. Phase 1 has no
      // out-of-band sender wired in (that's a product decision),
      // so we return it directly. The hashing on the server side
      // means the OTP itself is never persisted.
      return NextResponse.json(result)
    } catch (innerErr) {
      if (innerErr instanceof TrustedAdminError) {
        return NextResponse.json(
          { error: innerErr.message, code: innerErr.code },
          { status: innerErr.status },
        )
      }
      throw innerErr
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
