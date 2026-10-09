// ============================================================
// /api/change-requests — list + create change requests.
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
  ChangeRequestError,
  createChangeRequest,
  listChangeRequests,
} from '@/lib/ai/runtime/change-requests-service'

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:changeRequestsList:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const url = new URL(request.url)
    const status = url.searchParams.get('status') ?? undefined
    const rows = await listChangeRequests(ctx.accountId, { status })
    return NextResponse.json({ requests: rows })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface CreateBody {
  targetType: string
  targetId?: string | null
  intent: 'create' | 'update' | 'publish' | 'cancel' | 'archive'
  proposedPayload: Record<string, unknown>
  expectedVersion?: number | null
  idempotencyKey: string
  summary?: string | null
}

const VALID_TARGET_TYPES = new Set([
  'service',
  'service_revision',
  'pricing_rule',
  'fx_rate_pair',
  'fx_trade_request',
  'coverage_offer',
  'coverage_request',
])
const VALID_INTENTS = new Set([
  'create',
  'update',
  'publish',
  'cancel',
  'archive',
])

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:changeRequestCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    let body: CreateBody
    try {
      body = (await request.json()) as CreateBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (
      !body.targetType ||
      !VALID_TARGET_TYPES.has(body.targetType) ||
      !body.intent ||
      !VALID_INTENTS.has(body.intent) ||
      !body.idempotencyKey ||
      typeof body.proposedPayload !== 'object' ||
      body.proposedPayload === null
    ) {
      return NextResponse.json(
        { error: 'targetType, intent, idempotencyKey, proposedPayload are required' },
        { status: 400 },
      )
    }

    try {
      const result = await createChangeRequest({
        accountId: ctx.accountId,
        targetType: body.targetType,
        targetId: body.targetId ?? null,
        intent: body.intent,
        proposedPayload: body.proposedPayload,
        expectedVersion: body.expectedVersion ?? null,
        idempotencyKey: body.idempotencyKey,
        summary: body.summary ?? null,
        actorUserId: ctx.userId,
      })
      return NextResponse.json({ request: result })
    } catch (err) {
      if (err instanceof ChangeRequestError) {
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
