// ============================================================
// GET  /api/agent-routes             — list routes for the account
// POST /api/agent-routes             — create a route
// POST /api/agent-routes/simulate    — pure-function sim, no side
//                                       effects. Admin+. Phase 1
//                                       keeps the contract narrow:
//                                       only "default" + "rule" are
//                                       creatable; admin routes are
//                                       seeded by the backfill.
//
// All endpoints require admin+.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import type { AiAgentRoute, RouteConditions } from '@/lib/ai/runtime/multi-agent-types'

export async function GET() {
  try {
    const ctx = await requireRole('admin')

    const limit = checkRateLimit(
      `admin:agentRoutesList:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const { data, error } = await ctx.supabase
      .from('ai_agent_routes')
      .select(
        'id, account_id, agent_id, name, channel, route_kind, priority, is_active, conditions, stop_processing, created_at, updated_at',
      )
      .eq('account_id', ctx.accountId)
      .order('priority', { ascending: false })

    if (error) {
      console.error('[GET /api/agent-routes] error:', error)
      return NextResponse.json(
        { error: 'Failed to list routes' },
        { status: 500 },
      )
    }
    return NextResponse.json({ routes: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface CreateRouteBody {
  agentId: string
  name: string
  channel?: 'whatsapp'
  routeKind: 'rule' | 'default' | 'admin'
  priority?: number
  isActive?: boolean
  conditions?: RouteConditions
  stopProcessing?: boolean
}

const VALID_KINDS = new Set(['rule', 'default', 'admin'])

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const limit = checkRateLimit(
      `admin:agentRouteCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    let body: CreateRouteBody
    try {
      body = (await request.json()) as CreateRouteBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (!body.agentId || !body.name) {
      return NextResponse.json(
        { error: 'agentId and name are required' },
        { status: 400 },
      )
    }
    if (!VALID_KINDS.has(body.routeKind)) {
      return NextResponse.json(
        { error: 'routeKind must be one of: rule, default, admin' },
        { status: 400 },
      )
    }

    // Validate conditions against the closed schema. Unknown keys
    // are rejected to keep the router's contract tight.
    const cleanedConditions = validateConditions(body.conditions ?? {})

    // Verify the agent belongs to the account.
    const { data: agentRow, error: agentErr } = await ctx.supabase
      .from('ai_agents')
      .select('id')
      .eq('account_id', ctx.accountId)
      .eq('id', body.agentId)
      .maybeSingle()
    if (agentErr) {
      console.error('[POST /api/agent-routes] agent read failed:', agentErr)
      return NextResponse.json(
        { error: 'Failed to read agent' },
        { status: 500 },
      )
    }
    if (!agentRow) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    const { data, error } = await ctx.supabase
      .from('ai_agent_routes')
      .insert({
        account_id: ctx.accountId,
        agent_id: body.agentId,
        name: body.name,
        channel: body.channel ?? 'whatsapp',
        route_kind: body.routeKind,
        priority: body.priority ?? 100,
        is_active: body.isActive ?? true,
        conditions: cleanedConditions,
        stop_processing: body.stopProcessing ?? true,
        created_by: ctx.userId,
      })
      .select(
        'id, account_id, agent_id, name, channel, route_kind, priority, is_active, conditions, stop_processing, created_at, updated_at',
      )
      .single()

    if (error || !data) {
      console.error('[POST /api/agent-routes] insert failed:', error)
      // 23505 = unique violation — surfaces when there's already
      // an active default route for this channel.
      const code = (error as { code?: string } | null)?.code
      if (code === '23505') {
        return NextResponse.json(
          {
            error:
              'There is already an active default route for this channel.',
          },
          { status: 409 },
        )
      }
      return NextResponse.json(
        { error: 'Failed to create route' },
        { status: 500 },
      )
    }
    return NextResponse.json({ route: data as unknown as AiAgentRoute })
  } catch (err) {
    return toErrorResponse(err)
  }
}

function validateConditions(input: RouteConditions): RouteConditions {
  const out: RouteConditions = {}
  if (typeof input.inbox_id === 'string') {
    out.inbox_id = input.inbox_id
  }
  if (Array.isArray(input.tags)) {
    out.tags = input.tags.filter((t): t is string => typeof t === 'string')
  }
  if (typeof input.language === 'string') {
    out.language = input.language
  }
  if (
    input.business_hours &&
    typeof input.business_hours === 'object' &&
    typeof input.business_hours.start === 'string' &&
    typeof input.business_hours.end === 'string' &&
    typeof input.business_hours.tz === 'string' &&
    Array.isArray(input.business_hours.weekdays)
  ) {
    out.business_hours = {
      start: input.business_hours.start,
      end: input.business_hours.end,
      tz: input.business_hours.tz,
      weekdays: input.business_hours.weekdays.filter(
        (d): d is number => typeof d === 'number',
      ),
    }
  }
  return out
}
