// ============================================================
// /api/pricing-rules — list + create pricing rules.
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
  createPricingRule,
  listPricingRules,
  ServiceError,
} from '@/lib/services/pricing/rules-crud'

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:pricingRulesList:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const rules = await listPricingRules(ctx.accountId)
    return NextResponse.json({ rules })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface CreateRuleBody {
  name: string
  kind: string
  feeCurrency?: string | null
  inputCurrency?: string | null
  minimumFee?: string | null
  maximumFee?: string | null
  roundingMode?: string | null
  formulaConfig: Record<string, unknown>
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:pricingRuleCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    let body: CreateRuleBody
    try {
      body = (await request.json()) as CreateRuleBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (!body.name || !body.kind || !body.formulaConfig) {
      return NextResponse.json(
        { error: 'name, kind, formulaConfig are required' },
        { status: 400 },
      )
    }
    try {
      const rule = await createPricingRule(
        ctx.accountId,
        {
          name: body.name,
          kind: body.kind as Parameters<typeof createPricingRule>[1]['kind'],
          feeCurrency: body.feeCurrency ?? null,
          inputCurrency: body.inputCurrency ?? null,
          minimumFee: body.minimumFee ?? null,
          maximumFee: body.maximumFee ?? null,
          roundingMode: body.roundingMode as Parameters<typeof createPricingRule>[1]['roundingMode'] ?? null,
          formulaConfig: body.formulaConfig,
        },
        ctx.userId,
      )
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
