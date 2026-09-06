// ============================================================
// /api/exchange-rate-books — list + create exchange rate books.
// Admin+ only.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:rateBooksList:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { data, error } = await ctx.supabase
      .from('exchange_rate_books')
      .select(
        'id, account_id, name, region, channel, settlement_method, timezone, stale_after_seconds, current_published_version_id, status, created_at, updated_at',
      )
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true })
    if (error) {
      console.error('[GET /api/exchange-rate-books] error:', error)
      return NextResponse.json(
        { error: 'Failed to list books' },
        { status: 500 },
      )
    }
    return NextResponse.json({ books: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface CreateBookBody {
  name: string
  region?: string | null
  channel?: 'whatsapp'
  settlementMethod?: 'cash' | 'bank' | 'wallet' | 'other' | null
  timezone?: string
  staleAfterSeconds?: number
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:rateBookCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    let body: CreateBookBody
    try {
      body = (await request.json()) as CreateBookBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (!body.name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }
    const { data, error } = await ctx.supabase
      .from('exchange_rate_books')
      .insert({
        account_id: ctx.accountId,
        name: body.name,
        region: body.region ?? null,
        channel: body.channel ?? 'whatsapp',
        settlement_method: body.settlementMethod ?? null,
        timezone: body.timezone ?? 'UTC',
        stale_after_seconds: body.staleAfterSeconds ?? 1800,
        status: 'active',
        created_by: ctx.userId,
      })
      .select(
        'id, account_id, name, region, channel, settlement_method, timezone, stale_after_seconds, current_published_version_id, status, created_at, updated_at',
      )
      .single()
    if (error || !data) {
      const code = (error as { code?: string } | null)?.code
      if (code === '23505') {
        return NextResponse.json(
          {
            error:
              'A book with this (region, channel, settlement) already exists for this account.',
          },
          { status: 409 },
        )
      }
      console.error('[POST /api/exchange-rate-books] error:', error)
      return NextResponse.json(
        { error: 'Failed to create book' },
        { status: 500 },
      )
    }
    return NextResponse.json({ book: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
