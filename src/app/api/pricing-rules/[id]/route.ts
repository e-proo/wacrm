// ============================================================
// /api/pricing-rules/[id] — read/update/publish a single rule.
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
  getPricingRule,
  publishPricingRuleRaw,
  updatePricingRule,
  ServiceError,
} from '@/lib/services/pricing/rules-crud'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:pricingRuleRead:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params
    const rule = await getPricingRule(ctx.accountId, id)
    if (!rule) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json({ rule })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:pricingRuleUpdate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    let body: {
      name: string
      kind: string
      feeCurrency?: string | null
      inputCurrency?: string | null
      minimumFee?: string | null
      maximumFee?: string | null
      roundingMode?: string | null
      formulaConfig: Record<string, unknown>
    }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    try {
      const rule = await updatePricingRule(ctx.accountId, id, {
        name: body.name,
        kind: body.kind as Parameters<typeof updatePricingRule>[2]['kind'],
        feeCurrency: body.feeCurrency ?? null,
        inputCurrency: body.inputCurrency ?? null,
        minimumFee: body.minimumFee ?? null,
        maximumFee: body.maximumFee ?? null,
        roundingMode: body.roundingMode as Parameters<typeof updatePricingRule>[2]['roundingMode'] ?? null,
        formulaConfig: body.formulaConfig,
      })
      return NextResponse.json({ rule })
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

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // POST /api/pricing-rules/[id]/publish — promote draft to published.
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:pricingRulePublish:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params
    try {
      const rule = await publishPricingRuleRaw(ctx.accountId, id, ctx.userId)
      return NextResponse.json({ rule })
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
