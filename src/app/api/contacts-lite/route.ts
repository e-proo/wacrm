// ============================================================
// GET /api/contacts-lite — lightweight contact list for dropdowns
// (id, name, phone only). Admin+ only. Avoids pulling the full
// contact graph into marketplace pickers.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:contactsLite:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const url = new URL(request.url)
    const q = url.searchParams.get('q')?.trim() ?? ''
    const cap = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 200)

    let query = ctx.supabase
      .from('contacts')
      .select('id, name, phone')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .limit(cap)
    if (q) {
      const term = `%${q}%`
      query = query.or(`name.ilike.${term},phone.ilike.${term}`)
    }
    const { data, error } = await query
    if (error) {
      console.error('[GET /api/contacts-lite] error:', error)
      return NextResponse.json(
        { error: 'Failed to list contacts' },
        { status: 500 },
      )
    }
    return NextResponse.json({ contacts: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
