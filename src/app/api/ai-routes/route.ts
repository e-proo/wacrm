// ============================================================
// /api/ai-routes — CRUD for ai_agent_routes: the rules that
// decide WHICH agent handles an inbound message.
//
// Kind semantics (046):
//   • 'admin'   — admin plane (trusted identity); runs first.
//   • 'rule'    — ordered condition rules.
//   • 'default' — fallback; AT MOST ONE active per channel.
//
// Admin+ only. Conditions are validated through the closed
// schema (src/lib/ai/runtime/route-rules.ts) so a typo cannot
// silently create a dead rule.
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

interface RouteBody {
  name?: string
  agentId?: string
  routeKind?: string
  channel?: string
  priority?: number
  isActive?: boolean
  stopProcessing?: boolean
  conditions?: unknown
}

function buildUpdate(body: RouteBody, errors: string[]): Record<string, unknown> | null {
  const update: Record<string, unknown> = {}
  if (body.name !== undefined) {
    const name = body.name.trim()
    if (!name || name.length > 100) errors.push('name is required (max 100 chars)')
    else update.name = name
  }
  if (body.routeKind !== undefined) {
    if (!(ROUTE_KINDS as readonly string[]).includes(body.routeKind)) {
      errors.push("routeKind must be 'admin', 'rule' or 'default'")
    } else {
      update.route_kind = body.routeKind
    }
  }
  if (body.channel !== undefined) {
    if (!(ROUTE_CHANNELS as readonly string[]).includes(body.channel)) {
      errors.push('channel must be whatsapp')
    } else {
      update.channel = body.channel
    }
  }
  if (body.priority !== undefined) {
    if (!Number.isInteger(body.priority) || body.priority < 0 || body.priority > 10000) {
      errors.push('priority must be an integer 0-10000')
    } else {
      update.priority = body.priority
    }
  }
  if (body.isActive !== undefined) update.is_active = Boolean(body.isActive)
  if (body.stopProcessing !== undefined) {
    update.stop_processing = Boolean(body.stopProcessing)
  }
  if (body.conditions !== undefined) {
    const v = validateRouteConditions(body.conditions)
    if (!v.ok) errors.push(...v.errors)
    else update.conditions = v.conditions
  }
  return Object.keys(update).length > 0 ? update : null
}

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:aiRoutesList:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const [routesRes, agentsRes] = await Promise.all([
      ctx.supabase
        .from('ai_agent_routes')
        .select(
          'id, agent_id, name, channel, route_kind, priority, is_active, conditions, stop_processing, created_at, updated_at',
        )
        .eq('account_id', ctx.accountId),
      ctx.supabase
        .from('ai_agents')
        .select('id, name, status'),
    ])
    if (routesRes.error) throw routesRes.error
    if (agentsRes.error) throw agentsRes.error
    const names = new Map(
      (agentsRes.data ?? []).map((a) => [
        (a as { id: string }).id,
        (a as { name: string }).name,
      ]),
    )
    const kindOrder: Record<string, number> = { admin: 0, rule: 1, default: 2 }
    const routes: Array<Record<string, unknown>> = (
      (routesRes.data ?? []) as Array<Record<string, unknown>>
    ).map((row) => ({ ...row, agent_name: names.get(row.agent_id as string) ?? null }))
    routes.sort((a, b) => {
      const ka = kindOrder[String(a.route_kind)] ?? 9
      const kb = kindOrder[String(b.route_kind)] ?? 9
      if (ka !== kb) return ka - kb
      return Number(b.priority) - Number(a.priority)
    })
    return NextResponse.json({ routes, agents: agentsRes.data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:aiRoutesCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    let body: RouteBody
    try {
      body = (await request.json()) as RouteBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    const errors: string[] = []
    if (!body.agentId) errors.push('agentId is required')
    if (!body.name) errors.push('name is required')
    const update = buildUpdate(
      {
        ...body,
        routeKind: body.routeKind ?? 'rule',
        channel: body.channel ?? 'whatsapp',
      },
      errors,
    )
    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join('; ') }, { status: 400 })
    }
    if (!update) return NextResponse.json({ error: 'Nothing supplied' }, { status: 400 })

    // Validate the target agent exists for this account.
    const { data: agent } = await ctx.supabase
      .from('ai_agents')
      .select('id')
      .eq('account_id', ctx.accountId)
      .eq('id', body.agentId)
      .maybeSingle()
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    // One active default per channel — clear the previous
    // default before switching kinds so the partial unique index
    // cannot be violated mid-request.
    const channel = (update.channel as string) ?? 'whatsapp'
    if (update.route_kind === 'default' && update.is_active !== false) {
      const { error: demoteErr } = await ctx.supabase
        .from('ai_agent_routes')
        .update({ is_active: false })
        .eq('account_id', ctx.accountId)
        .eq('channel', channel)
        .eq('route_kind', 'default')
        .eq('is_active', true)
      if (demoteErr) throw demoteErr
    }

    const { data, error } = await ctx.supabase
      .from('ai_agent_routes')
      .insert({
        account_id: ctx.accountId,
        agent_id: body.agentId,
        created_by: ctx.userId,
        ...update,
      })
      .select(
        'id, agent_id, name, channel, route_kind, priority, is_active, conditions, stop_processing, created_at, updated_at',
      )
      .single()
    if (error || !data) {
      const code = (error as { code?: string } | null)?.code
      if (code === '23505') {
        return NextResponse.json(
          { error: 'An active default route already exists for this channel.' },
          { status: 409 },
        )
      }
      console.error('[POST /api/ai-routes] failed:', error)
      return NextResponse.json({ error: 'Failed to create route' }, { status: 500 })
    }
    return NextResponse.json({ route: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
