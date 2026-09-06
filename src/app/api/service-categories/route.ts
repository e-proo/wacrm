// ============================================================
// /api/service-categories — list + create service categories.
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
      `admin:categoriesList:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { data, error } = await ctx.supabase
      .from('service_categories')
      .select(
        'id, account_id, slug, name, description, status, current_schema_version_id, created_at, updated_at',
      )
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true })
    if (error) {
      console.error('[GET /api/service-categories] error:', error)
      return NextResponse.json(
        { error: 'Failed to list categories' },
        { status: 500 },
      )
    }
    return NextResponse.json({ categories: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface CreateCategoryBody {
  slug: string
  name: string
  description?: string | null
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:categoryCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    let body: CreateCategoryBody
    try {
      body = (await request.json()) as CreateCategoryBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (!body.slug || !body.name) {
      return NextResponse.json(
        { error: 'slug and name are required' },
        { status: 400 },
      )
    }
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(body.slug)) {
      return NextResponse.json(
        { error: 'slug must be lowercase alphanumeric with optional hyphens' },
        { status: 400 },
      )
    }
    const { data, error } = await ctx.supabase
      .from('service_categories')
      .insert({
        account_id: ctx.accountId,
        slug: body.slug,
        name: body.name,
        description: body.description ?? null,
        status: 'active',
        created_by: ctx.userId,
      })
      .select(
        'id, account_id, slug, name, description, status, current_schema_version_id, created_at, updated_at',
      )
      .single()
    if (error || !data) {
      const code = (error as { code?: string } | null)?.code
      if (code === '23505') {
        return NextResponse.json(
          { error: 'A category with that slug already exists.' },
          { status: 409 },
        )
      }
      console.error('[POST /api/service-categories] error:', error)
      return NextResponse.json(
        { error: 'Failed to create category' },
        { status: 500 },
      )
    }
    return NextResponse.json({ category: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
