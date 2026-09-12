// ============================================================
// /api/coverage/requests — list + create coverage requests.
// Admin+ only.
//
// v2 (migration 059): carries the editable deal_date and the
// validated structured attributes (scope, receive/pay legs).
// NOTE: requests never set a commission — the requester reviews
// offers WITH their commission in the suggestions view.
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

const REQUEST_SELECT =
  'id, account_id, service_id, requester_contact_id, requested_amount, reserved_amount, fulfilled_amount, currency, attributes, commission_per_thousand, commission_currency, commission_amount, deal_date, expires_at, priority, notes, status, version, created_at, updated_at'

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:coverageRequestsList:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { data, error } = await ctx.supabase
      .from('coverage_requests')
      .select(REQUEST_SELECT)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
    if (error) {
      console.error('[GET /api/coverage/requests] error:', error)
      return NextResponse.json(
        { error: 'Failed to list requests' },
        { status: 500 },
      )
    }
    return NextResponse.json({ requests: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface CreateRequestBody {
  serviceId?: string
  requesterContactId: string
  requestedAmount: string
  currency: string
  attributes?: Record<string, unknown>
  commissionPerThousand?: string | null
  commissionCurrency?: string | null
  dealDate?: string | null
  expiresAt?: string | null
  priority?: 'low' | 'normal' | 'high'
  notes?: string
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:coverageRequestCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    let body: CreateRequestBody
    try {
      body = (await request.json()) as CreateRequestBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    const total = parseDecimal(body.requestedAmount, { rejectZero: true })
    if (!body.requesterContactId || !body.currency || !total) {
      return NextResponse.json(
        { error: 'requesterContactId, requestedAmount, currency are required' },
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
      .from('coverage_requests')
      .insert({
        account_id: ctx.accountId,
        service_id: serviceId,
        requester_contact_id: body.requesterContactId,
        requested_amount: total.toString(),
        currency: body.currency,
        attributes: attrs.normalized,
        commission_per_thousand:
          commissionRate === null ? null : commissionRate.toString(),
        commission_currency: commissionCurrency,
        deal_date: body.dealDate ?? null,
        expires_at: body.expiresAt ?? null,
        priority: body.priority ?? 'normal',
        notes: body.notes ?? null,
        status: 'draft',
        created_by: ctx.userId,
      })
      .select(REQUEST_SELECT)
      .single()
    if (error || !data) {
      console.error('[POST /api/coverage/requests] error:', error)
      return NextResponse.json(
        { error: 'Failed to create request' },
        { status: 500 },
      )
    }
    return NextResponse.json({ request: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
