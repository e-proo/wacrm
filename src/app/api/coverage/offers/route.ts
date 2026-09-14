// ============================================================
// /api/coverage/offers — list + create coverage offers.
// Admin+ only.
//
// v2 (migration 059): carries the commission fields
// (per-thousand rate + currency; the amount is GENERATED as
// amount × rate ÷ 1000), the editable deal_date, and the
// validated structured attributes (scope, receive/pay legs).
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { parseDecimal } from '@/lib/services/pricing/decimal'
import { normalizeCoverageAttributes } from '@/lib/services/coverage/attributes'
import { ensureCoverageService } from '@/lib/services/coverage/ensure-service'

const COMMISSION_CURRENCY_RE = /^[A-Z_]{3,8}$/
const DEAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const OFFER_SELECT =
  'id, account_id, service_id, provider_contact_id, reference_code, total_amount, reserved_amount, fulfilled_amount, currency, attributes, commission_per_thousand, commission_currency, commission_amount, deal_date, notes, available_from, expires_at, status, version, created_at, updated_at'

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:coverageOffersList:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { data, error } = await ctx.supabase
      .from('coverage_offers')
      .select(OFFER_SELECT)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
    if (error) {
      console.error('[GET /api/coverage/offers] error:', error)
      return NextResponse.json(
        { error: 'Failed to list offers' },
        { status: 500 },
      )
    }
    return NextResponse.json({ offers: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface CreateOfferBody {
  serviceId: string
  providerContactId: string
  referenceCode: string
  totalAmount: string
  currency: string
  attributes?: Record<string, unknown>
  commissionPerThousand?: string | null
  commissionCurrency?: string | null
  dealDate?: string | null
  notes?: string | null
  availableFrom?: string | null
  expiresAt?: string | null
  providerCost?: string | null
  providerCostCurrency?: string | null
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:coverageOfferCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    let body: CreateOfferBody
    try {
      body = (await request.json()) as CreateOfferBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    const total = parseDecimal(body.totalAmount, { rejectZero: true })
    if (!body.providerContactId || !body.currency || !total) {
      return NextResponse.json(
        { error: 'providerContactId, totalAmount, currency are required' },
        { status: 400 },
      )
    }
    // The dedicated coverage service is resolved (or created)
    // server-side — the operator never manages the catalog here.
    const serviceId = body.serviceId || (await ensureCoverageService(ctx.accountId))

    const attrs = normalizeCoverageAttributes(body.attributes)
    if (!attrs.ok) {
      return NextResponse.json(
        { error: 'Invalid attributes', details: attrs.errors },
        { status: 400 },
      )
    }

    const commissionRate = parseDecimal(body.commissionPerThousand ?? null)
    if (body.commissionPerThousand != null && body.commissionPerThousand !== '' && !commissionRate) {
      return NextResponse.json(
        { error: 'commissionPerThousand must be a non-negative number' },
        { status: 400 },
      )
    }
    const commissionCurrency = body.commissionCurrency
      ? body.commissionCurrency.trim().toUpperCase()
      : null
    if (commissionCurrency && !COMMISSION_CURRENCY_RE.test(commissionCurrency)) {
      return NextResponse.json(
        { error: 'commissionCurrency must be 3-8 uppercase letters (e.g. SAR)' },
        { status: 400 },
      )
    }
    if (commissionRate && !commissionCurrency) {
      return NextResponse.json(
        { error: 'commissionCurrency is required when a commission rate is set' },
        { status: 400 },
      )
    }
    if (body.dealDate && !DEAL_DATE_RE.test(body.dealDate)) {
      return NextResponse.json(
        { error: 'dealDate must be YYYY-MM-DD' },
        { status: 400 },
      )
    }

    const { data, error } = await ctx.supabase
      .from('coverage_offers')
      .insert({
        account_id: ctx.accountId,
        service_id: serviceId,
        provider_contact_id: body.providerContactId,
        reference_code: body.referenceCode || `OFF-${Date.now()}`,
        total_amount: total.toString(),
        currency: body.currency,
        attributes: attrs.normalized,
        commission_per_thousand:
          commissionRate === null ? null : commissionRate.toString(),
        commission_currency: commissionCurrency,
        deal_date: body.dealDate ?? null,
        notes: body.notes ? String(body.notes).slice(0, 1000) : null,
        available_from: body.availableFrom ?? null,
        expires_at: body.expiresAt ?? null,
        provider_cost: body.providerCost ?? null,
        provider_cost_currency: body.providerCostCurrency ?? null,
        status: 'draft',
        created_by: ctx.userId,
      })
      .select(OFFER_SELECT)
      .single()
    if (error || !data) {
      const code = (error as { code?: string } | null)?.code
      if (code === '23505') {
        return NextResponse.json(
          { error: 'An offer with this reference code already exists.' },
          { status: 409 },
        )
      }
      console.error('[POST /api/coverage/offers] error:', error)
      return NextResponse.json(
        { error: 'Failed to create offer' },
        { status: 500 },
      )
    }
    return NextResponse.json({ offer: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
