// ============================================================
// PATCH /api/ai-agents/[id] — edit the agent identity row
// (display name + description). Admin+. Purpose, slug and
// system_key are immutable.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

interface PatchBody {
  name?: string
  description?: string | null
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:aiAgentPatch:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    let body: PatchBody
    try {
      body = (await request.json()) as PatchBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const update: Record<string, unknown> = { updated_by: ctx.userId }
    if (body.name !== undefined) {
      const name = body.name.trim()
      if (!name || name.length > 100) {
        return NextResponse.json(
          { error: 'name is required (max 100 chars)' },
          { status: 400 },
        )
      }
      update.name = name
    }
    if (body.description !== undefined) {
      if (
        body.description !== null &&
        String(body.description).length > 500
      ) {
        return NextResponse.json(
          { error: 'description is too long (max 500 chars)' },
          { status: 400 },
        )
      }
      update.description = body.description ?? null
    }
    if (Object.keys(update).length <= 1) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const { data, error } = await ctx.supabase
      .from('ai_agents')
      .update(update)
      .eq('account_id', ctx.accountId)
      .eq('id', id)
      .select(
        'id, account_id, system_key, slug, name, description, purpose, status, published_revision_id, version, created_at, updated_at',
      )
      .maybeSingle()
    if (error || !data) {
      console.error('[PATCH /api/ai-agents/[id]] failed:', error)
      return NextResponse.json({ error: 'Failed to update agent' }, { status: 500 })
    }
    return NextResponse.json({ agent: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
