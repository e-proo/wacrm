// ============================================================
// /api/coverage/requests — list + create coverage requests.
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
      `admin:coverageRequestsList:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { data, error } = await ctx.supabase
      .from('coverage_requests')
      .select(
        'id, account_id, service_id, requester_contact_id, requested_amount, reserved_amount, fulfilled_amount, currency, attributes, expires_at, priority, notes, status, version, created_at, updated_at',
      )
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
  serviceId: string
  requesterContactId: string
  requestedAmount: string
  currency: string
  attributes?: Record<string, unknown>
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
    if (!body.serviceId || !body.requesterContactId || !body.currency || !total) {
      return NextResponse.json(
        { error: 'serviceId, requesterContactId, requestedAmount, currency are required' },
        { status: 400 },
      )
    }

    const { data, error } = await ctx.supabase
      .from('coverage_requests')
      .insert({
        account_id: ctx.accountId,
        service_id: body.serviceId,
        requester_contact_id: body.requesterContactId,
        requested_amount: total.toString(),
        currency: body.currency,
        attributes: body.attributes ?? {},
        expires_at: body.expiresAt ?? null,
        priority: body.priority ?? 'normal',
        notes: body.notes ?? null,
        status: 'draft',
        created_by: ctx.userId,
      })
      .select(
        'id, account_id, service_id, requester_contact_id, requested_amount, reserved_amount, fulfilled_amount, currency, attributes, expires_at, priority, notes, status, version, created_at, updated_at',
      )
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
