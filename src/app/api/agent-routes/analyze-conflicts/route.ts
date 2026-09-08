// ============================================================
// POST /api/agent-routes/analyze-conflicts — pure conflict check
// over the account's routes. No side effects. Admin+ only.
//
// The builder's publish checklist calls this before flipping
// published_revision_id (Phase 4 §8 item 11: "المسارات لا
// تتعارض، والـ admin route محمي بهوية موثوقة").
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { analyzeRouteConflicts } from '@/lib/ai/runtime/route-conflicts'

export async function POST() {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:routeConflicts:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const [routesRes, agentsRes, identityRes] = await Promise.all([
      ctx.supabase
        .from('ai_agent_routes')
        .select(
          'id, account_id, agent_id, name, channel, route_kind, priority, is_active, conditions, stop_processing, created_at, updated_at',
        )
        .eq('account_id', ctx.accountId),
      ctx.supabase
        .from('ai_agents')
        .select('id, status, purpose')
        .eq('account_id', ctx.accountId),
      ctx.supabase
        .from('trusted_admin_identities')
        .select('id', { head: true, count: 'exact' })
        .eq('account_id', ctx.accountId)
        .eq('status', 'active')
        .limit(1),
    ])
    if (routesRes.error) throw routesRes.error
    if (agentsRes.error) throw agentsRes.error

    const conflicts = analyzeRouteConflicts({
      routes: (routesRes.data ?? []) as never,
      agents: (agentsRes.data ?? []) as never,
      hasActiveTrustedIdentity: (identityRes.count ?? 0) > 0,
    })

    return NextResponse.json({
      conflicts,
      hasBlockers: conflicts.some((c) => c.severity === 'blocker'),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
