// ============================================================
// /api/services — list + create services.
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
      `admin:servicesList:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { data, error } = await ctx.supabase
      .from('services')
      .select(
        'id, account_id, category_id, code, slug, name, status, current_revision_id, version, created_at, updated_at',
      )
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true })
    if (error) {
      console.error('[GET /api/services] error:', error)
      return NextResponse.json(
        { error: 'Failed to list services' },
        { status: 500 },
      )
    }
    return NextResponse.json({ services: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface CreateServiceBody {
  categoryId: string
  code: string
  slug: string
  name: string
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:serviceCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    let body: CreateServiceBody
    try {
      body = (await request.json()) as CreateServiceBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (!body.categoryId || !body.code || !body.slug || !body.name) {
      return NextResponse.json(
        { error: 'categoryId, code, slug, and name are required' },
        { status: 400 },
      )
    }

    // Verify the category belongs to this account.
    const { data: cat, error: catErr } = await ctx.supabase
      .from('service_categories')
      .select('id')
      .eq('account_id', ctx.accountId)
      .eq('id', body.categoryId)
      .maybeSingle()
    if (catErr) {
      console.error('[POST /api/services] category check failed:', catErr)
      return NextResponse.json(
        { error: 'Failed to verify category' },
        { status: 500 },
      )
    }
    if (!cat) {
      return NextResponse.json({ error: 'Category not found' }, { status: 404 })
    }

    const { data, error } = await ctx.supabase
      .from('services')
      .insert({
        account_id: ctx.accountId,
        category_id: body.categoryId,
        code: body.code,
        slug: body.slug,
        name: body.name,
        status: 'draft',
        created_by: ctx.userId,
      })
      .select(
        'id, account_id, category_id, code, slug, name, status, current_revision_id, version, created_at, updated_at',
      )
      .single()
    if (error || !data) {
      const code = (error as { code?: string } | null)?.code
      if (code === '23505') {
        return NextResponse.json(
          { error: 'A service with that code or slug already exists.' },
          { status: 409 },
        )
      }
      console.error('[POST /api/services] error:', error)
      return NextResponse.json(
        { error: 'Failed to create service' },
        { status: 500 },
      )
    }
    return NextResponse.json({ service: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
