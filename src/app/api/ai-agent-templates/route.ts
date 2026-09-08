// ============================================================
// /api/ai-agent-templates — list agent templates visible to the
// caller (system templates + the account's own clones).
//
// Phase 4 §11: the builder's step 1 reads this list. Creating an
// agent from a template goes through POST /api/ai-agents (which
// now accepts a template_id).
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
      `admin:agentTemplates:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    // System templates (account_id is null) + own clones. The
    // RLS select policy already expresses this split; the query
    // mirrors it explicitly so the admin client (which bypasses
    // RLS) doesn't leak other accounts' templates.
    const { data, error } = await ctx.supabase
      .from('ai_agent_templates')
      .select(
        'id, account_id, system_template_key, name, description, purpose, version, default_settings, suggested_tool_keys, required_policies, is_active, created_at',
      )
      .or(`account_id.is.null,account_id.eq.${ctx.accountId}`)
      .eq('is_active', true)
      .order('system_template_key', { ascending: true, nullsFirst: false })

    if (error) {
      console.error('[GET /api/ai-agent-templates] error:', error)
      return NextResponse.json(
        { error: 'Failed to list templates' },
        { status: 500 },
      )
    }
    return NextResponse.json({ templates: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
