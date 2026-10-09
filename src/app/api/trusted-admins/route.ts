import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  listTrustedAdmins,
  registerTrustedAdmin,
  TrustedAdminError,
} from '@/lib/ai/runtime/trusted-admins-service'
import { sendTrustedAdminOtp } from '@/lib/ai/runtime/trusted-admin-otp'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import type { TrustedAdminIdentity } from '@/lib/ai/runtime/multi-agent-types'

function dto(identity: TrustedAdminIdentity) {
  return {
    id: identity.id,
    channel: identity.channel,
    normalized_address: identity.normalizedAddress,
    display_name: identity.displayName,
    member_id: identity.memberId,
    status: identity.status,
    verification_method: identity.verificationMethod,
    verified_at: identity.verifiedAt,
    revoked_at: identity.revokedAt,
    allowed_capabilities: identity.allowedCapabilities,
    created_at: identity.createdAt,
  }
}

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:trustedAdminsList:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const identities = await listTrustedAdmins(ctx.supabase, ctx.accountId)
    return NextResponse.json({ identities: identities.map(dto) })
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
    const limit = checkRateLimit(`admin:trustedAdminRegister:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    let body: RegisterBody
    try {
      body = (await request.json()) as RegisterBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (!body.phone) return NextResponse.json({ error: 'phone is required' }, { status: 400 })

    try {
      // Mutations use the service-role path after this endpoint has already
      // authenticated + authorized the caller. RLS therefore cannot be used
      // from a browser to promote a trusted identity directly.
      const result = await registerTrustedAdmin(supabaseAdmin(), {
        accountId: ctx.accountId,
        rawPhone: body.phone,
        displayName: body.displayName ?? null,
        memberId: body.memberId ?? null,
        actorUserId: ctx.userId,
      })
      const delivery = await sendTrustedAdminOtp({
        accountId: ctx.accountId,
        normalizedAddress: result.identity.normalizedAddress,
        otp: result.otp,
      })
      // Meta accepting /messages is not the same as handset delivery.
      return NextResponse.json({ identity: dto(result.identity), otpSent: true, delivery }, { status: 201 })
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
