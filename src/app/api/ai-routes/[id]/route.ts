// ============================================================
// PATCH  /api/ai-routes/[id] — partial route update
// DELETE /api/ai-routes/[id] — remove route
// Admin+ only. Switching kind to 'default' demotes any other
// active default on the same channel so the unique index holds.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  ROUTE_KINDS,
  ROUTE_CHANNELS,
  validateRouteConditions,
} from '@/lib/ai/runtime/route-rules'

interface PatchBody {
  name?: string
  agentId?: string
  routeKind?: string
  channel?: string
  priority?: number
  isActive?: boolean
  stopProcessing?: boolean
  conditions?: unknown
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:aiRoutesPatch:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params

    const { data: existing, error: readErr } = await ctx.supabase
      .from('ai_agent_routes')
      .select('id, channel, route_kind, agent_id')
      .eq('account_id', ctx.accountId)
      .eq('id', id)
      .maybeSingle()
    if (readErr) throw readErr
    if (!existing) {
      return NextResponse.json({ error: 'Route not found' }, { status: 404 })
    }
    const ex = existing as {
      channel: string
      route_kind: string
      agent_id: string
    }

    let body: PatchBody
    try {
      body = (await request.json()) as PatchBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const errors: string[] = []
    // ai_agent_routes has no updated_by column (046) — the
    // updated_at trigger stamps the row; actor audit is not stored.
    const update: Record<string, unknown> = {}
    if (body.name !== undefined) {
      const name = body.name.trim()
      if (!name || name.length > 100) errors.push('name is required (max 100 chars)')
      else update.name = name
    }
    const nextKind = body.routeKind ?? ex.route_kind
    if (body.routeKind !== undefined && !(ROUTE_KINDS as readonly string[]).includes(body.routeKind)) {
      errors.push("routeKind must be 'admin', 'rule' or 'default'")
    }
    const nextChannel = body.channel ?? ex.channel
    if (body.channel !== undefined && !(ROUTE_CHANNELS as readonly string[]).includes(body.channel)) {
      errors.push('channel must be whatsapp')
    }
    update.route_kind = nextKind
    update.channel = nextChannel
    if (body.priority !== undefined) {
      if (!Number.isInteger(body.priority) || body.priority < 0 || body.priority > 10000) {
        errors.push('priority must be an integer 0-10000')
      } else {
        update.priority = body.priority
      }
    }
    if (body.isActive !== undefined) update.is_active = Boolean(body.isActive)
    if (body.stopProcessing !== undefined) update.stop_processing = Boolean(body.stopProcessing)
    if (body.conditions !== undefined) {
      const v = validateRouteConditions(body.conditions)
      if (!v.ok) errors.push(...v.errors)
      else update.conditions = v.conditions
    }
    const nextAgentId = body.agentId ?? ex.agent_id
    if (body.agentId !== undefined) {
      const { data: agent } = await ctx.supabase
        .from('ai_agents')
        .select('id')
        .eq('account_id', ctx.accountId)
        .eq('id', body.agentId)
        .maybeSingle()
      if (!agent) errors.push('agentId does not refer to an agent in this account')
    }
    update.agent_id = nextAgentId

    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join('; ') }, { status: 400 })
    }

    if (nextKind === 'default' && body.isActive !== false) {
      const { error: demoteErr } = await ctx.supabase
        .from('ai_agent_routes')
        .update({ is_active: false })
        .eq('account_id', ctx.accountId)
        .eq('channel', nextChannel)
        .eq('route_kind', 'default')
        .eq('is_active', true)
        .neq('id', id)
      if (demoteErr) throw demoteErr
    }

    const { data, error } = await ctx.supabase
      .from('ai_agent_routes')
      .update(update)
      .eq('account_id', ctx.accountId)
      .eq('id', id)
      .select(
        'id, agent_id, name, channel, route_kind, priority, is_active, conditions, stop_processing, created_at, updated_at',
      )
      .maybeSingle()
    if (error || !data) {
      const code = (error as { code?: string } | null)?.code
      if (code === '23505') {
        return NextResponse.json(
          { error: 'An active default route already exists for this channel.' },
          { status: 409 },
        )
      }
      console.error('[PATCH /api/ai-routes/[id]] failed:', error)
      return NextResponse.json({ error: 'Failed to update route' }, { status: 500 })
    }
    return NextResponse.json({ route: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:aiRoutesDelete:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params
    const { error } = await ctx.supabase
      .from('ai_agent_routes')
      .delete()
      .eq('account_id', ctx.accountId)
      .eq('id', id)
    if (error) {
      console.error('[DELETE /api/ai-routes/[id]] failed:', error)
      return NextResponse.json({ error: 'Failed to delete route' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
