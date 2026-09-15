import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  revokeTrustedAdmin,
  TrustedAdminError,
  listTrustedAdmins,
} from '@/lib/ai/runtime/trusted-admins-service'
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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:trustedAdminAction:${ctx.userId}`, RATE_LIMITS.adminAction)
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
        if (!body.otp) return NextResponse.json({ error: 'otp is required' }, { status: 400 })
        const { data: verification, error: verifyError } = await supabaseAdmin().rpc(
          'verify_trusted_admin_otp_v2',
          {
            p_account_id: ctx.accountId,
            p_identity_id: id,
            p_otp: body.otp,
            p_actor_user_id: ctx.userId,
          },
        )
        if (verifyError) throw verifyError
        const outcome = String(verification ?? 'conflict')
        const errors: Record<string, { status: number; code: string; message: string }> = {
          not_found: { status: 404, code: 'IDENTITY_NOT_FOUND', message: 'Identity not found.' },
          revoked: { status: 409, code: 'IDENTITY_REVOKED', message: 'This identity has been revoked.' },
          no_pending: { status: 409, code: 'NO_PENDING_OTP', message: 'No pending verification code.' },
          expired: { status: 410, code: 'OTP_EXPIRED', message: 'The verification code has expired.' },
          locked: { status: 429, code: 'OTP_TOO_MANY_ATTEMPTS', message: 'Too many verification attempts.' },
          mismatch: { status: 401, code: 'OTP_MISMATCH', message: 'OTP is incorrect.' },
          conflict: { status: 409, code: 'VERIFY_CONFLICT', message: 'Identity changed state. Reload and retry.' },
        }
        if (outcome !== 'active') {
          const mapped = errors[outcome] ?? errors.conflict
          return NextResponse.json(
            { error: mapped.message, code: mapped.code },
            { status: mapped.status },
          )
        }
        const identities = await listTrustedAdmins(supabaseAdmin(), ctx.accountId)
        const identity = identities.find((candidate) => candidate.id === id)
        if (!identity) return NextResponse.json({ error: 'Identity not found' }, { status: 404 })
        return NextResponse.json({ identity: dto(identity) })
      }

      if (action === 'revoke') {
        const identity = await revokeTrustedAdmin(supabaseAdmin(), {
          accountId: ctx.accountId,
          identityId: id,
          actorUserId: ctx.userId,
        })
        return NextResponse.json({ identity: dto(identity) })
      }


      if (action === 'capabilities') {
        let body: { capabilities?: unknown }
        try {
          body = (await request.json()) as { capabilities?: unknown }
        } catch {
          return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
        }
        if (
          !Array.isArray(body.capabilities) ||
          !body.capabilities.every((capability) => typeof capability === 'string')
        ) {
          return NextResponse.json(
            { error: 'capabilities must be an array of strings' },
            { status: 400 },
          )
        }
        const { error } = await ctx.supabase.rpc('set_trusted_admin_capabilities', {
          p_account_id: ctx.accountId,
          p_identity_id: id,
          p_capabilities: body.capabilities,
        })
        if (error) throw error
        const { data: row, error: readError } = await ctx.supabase
          .from('trusted_admin_identities')
          .select(
            'id, account_id, channel, normalized_address, display_name, member_id, status, verification_method, verified_at, revoked_at, allowed_capabilities, created_at',
          )
          .eq('account_id', ctx.accountId)
          .eq('id', id)
          .maybeSingle()
        if (readError) throw readError
        if (!row) return NextResponse.json({ error: 'Identity not found' }, { status: 404 })
        return NextResponse.json({ identity: row })
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
