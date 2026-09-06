// ============================================================
// /api/coverage/offers — list + create coverage offers.
// Admin+ only.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { parseDecimal } from '@/lib/services/pricing/decimal'

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
      .select(
        'id, account_id, service_id, provider_contact_id, reference_code, total_amount, reserved_amount, fulfilled_amount, currency, attributes, available_from, expires_at, status, version, created_at, updated_at',
      )
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
    if (!body.serviceId || !body.providerContactId || !body.referenceCode || !body.currency || !total) {
      return NextResponse.json(
        { error: 'serviceId, providerContactId, referenceCode, totalAmount, currency are required' },
        { status: 400 },
      )
    }

    const { data, error } = await ctx.supabase
      .from('coverage_offers')
      .insert({
        account_id: ctx.accountId,
        service_id: body.serviceId,
        provider_contact_id: body.providerContactId,
        reference_code: body.referenceCode,
        total_amount: total.toString(),
        currency: body.currency,
        attributes: body.attributes ?? {},
        available_from: body.availableFrom ?? null,
        expires_at: body.expiresAt ?? null,
        provider_cost: body.providerCost ?? null,
        provider_cost_currency: body.providerCostCurrency ?? null,
        status: 'draft',
        created_by: ctx.userId,
      })
      .select(
        'id, account_id, service_id, provider_contact_id, reference_code, total_amount, reserved_amount, fulfilled_amount, currency, attributes, available_from, expires_at, status, version, created_at, updated_at',
      )
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
