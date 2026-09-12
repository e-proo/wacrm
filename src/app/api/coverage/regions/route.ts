// ============================================================
// /api/coverage/regions — the coverage_regions registry
// (migration 059). Accounts are pre-seeded with the Yemeni
// north/south cities + an international row; admins can add
// more (e.g. new corridors).
//
// GET  — list active regions (macro first, then name).
// POST — create a region (admin+). Code must be stable
//        snake_case; (account_id, code) is unique.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

const CODE_RE = /^[a-z0-9_]{2,40}$/
const MACROS = ['north', 'south', 'international'] as const

interface RegionRow {
  id: string
  code: string
  name: string
  macro_region: string
  country: string
  status: string
}

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:coverageRegionsList:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { data, error } = await ctx.supabase
      .from('coverage_regions')
      .select('id, code, name, macro_region, country, status')
      .eq('account_id', ctx.accountId)
      .order('macro_region', { ascending: true })
      .order('name', { ascending: true })
    if (error) {
      console.error('[GET /api/coverage/regions] error:', error)
      return NextResponse.json(
        { error: 'Failed to list regions' },
        { status: 500 },
      )
    }
    return NextResponse.json({ regions: (data ?? []) as RegionRow[] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface CreateRegionBody {
  code: string
  name: string
  macroRegion: 'north' | 'south' | 'international'
  country?: string
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:coverageRegionCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    let body: CreateRegionBody
    try {
      body = (await request.json()) as CreateRegionBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    const code = (body.code ?? '').trim()
    const name = (body.name ?? '').trim()
    if (!CODE_RE.test(code)) {
      return NextResponse.json(
        { error: 'code must be 2-40 chars of lowercase letters, digits, underscores' },
        { status: 400 },
      )
    }
    if (!name || name.length > 100) {
      return NextResponse.json(
        { error: 'name is required (max 100 chars)' },
        { status: 400 },
      )
    }
    if (!(MACROS as readonly string[]).includes(body.macroRegion)) {
      return NextResponse.json(
        { error: 'macroRegion must be north, south, or international' },
        { status: 400 },
      )
    }

    const { data, error } = await ctx.supabase
      .from('coverage_regions')
      .insert({
        account_id: ctx.accountId,
        code,
        name,
        macro_region: body.macroRegion,
        country: (body.country ?? 'YE').trim().slice(0, 2).toUpperCase() || 'YE',
        created_by: ctx.userId,
      })
      .select('id, code, name, macro_region, country, status')
      .single()
    if (error || !data) {
      const code_ = (error as { code?: string } | null)?.code
      if (code_ === '23505') {
        return NextResponse.json(
          { error: 'A region with this code already exists.' },
          { status: 409 },
        )
      }
      console.error('[POST /api/coverage/regions] error:', error)
      return NextResponse.json(
        { error: 'Failed to create region' },
        { status: 500 },
      )
    }
    return NextResponse.json({ region: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
