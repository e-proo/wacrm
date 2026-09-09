// ============================================================
// /api/customer-intents — list + create customer intents.
// Admin+ only.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  IntentError,
  listIntents,
  recordIntent,
} from '@/lib/services/intents/intents-service'

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:intentsList:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const url = new URL(request.url)
    const status = url.searchParams.get('status') ?? undefined
    const contactId = url.searchParams.get('contact_id') ?? undefined
    const q = url.searchParams.get('q') ?? undefined
    const intents = await listIntents(ctx.accountId, { status, contactId, q })
    return NextResponse.json({ intents })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface CreateBody {
  contactId: string
  conversationId?: string | null
  direction: 'offer' | 'request'
  serviceHint: string
  summary?: string | null
  attributes?: Record<string, unknown>
  escalateToAdmin?: boolean
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:intentCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    let body: CreateBody
    try {
      body = (await request.json()) as CreateBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    try {
      const result = await recordIntent({
        accountId: ctx.accountId,
        contactId: body.contactId,
        conversationId: body.conversationId ?? null,
        direction: body.direction,
        serviceHint: body.serviceHint,
        summary: body.summary ?? null,
        attributes: body.attributes ?? {},
        escalateToAdmin: body.escalateToAdmin ?? false,
        actorUserId: ctx.userId,
      })
      return NextResponse.json(result)
    } catch (err) {
      if (err instanceof IntentError) {
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
