// ============================================================
// GET /api/agent-runs — list runs for the account (audit log)
// GET /api/agent-runs?conversation_id=... — narrow to one thread
//
// Phase 1 ships a read-only audit surface. Each row links to its
// `ai_agent_run_events` entries for forensic timeline viewing.
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
      `admin:agentRunsList:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const url = new URL(request.url)
    const conversationId = url.searchParams.get('conversation_id')

    let query = ctx.supabase
      .from('ai_agent_runs')
      .select(
        'id, account_id, conversation_id, inbound_message_id, ai_agent_id, agent_revision_id, route_id, route_reason, plane, status, attempt_count, input_tokens, output_tokens, started_at, completed_at, error_code, created_at',
      )
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .limit(100)
    if (conversationId) {
      query = query.eq('conversation_id', conversationId)
    }

    const { data, error } = await query
    if (error) {
      console.error('[GET /api/agent-runs] error:', error)
      return NextResponse.json(
        { error: 'Failed to list runs' },
        { status: 500 },
      )
    }
    return NextResponse.json({ runs: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
