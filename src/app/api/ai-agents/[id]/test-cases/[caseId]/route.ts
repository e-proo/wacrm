// ============================================================
// /api/ai-agents/[id]/test-cases/[caseId]
// DELETE — remove a test case
// Admin+ only. (Editing a test case = delete + re-add; there is
// no in-place edit form, so no PATCH surface to drift.)
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; caseId: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(
      `admin:agentTestCaseDelete:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)
    const { id, caseId } = await params
    const { error } = await ctx.supabase
      .from('ai_agent_test_cases')
      .delete()
      .eq('account_id', ctx.accountId)
      .eq('agent_id', id)
      .eq('id', caseId)
    if (error) {
      console.error('[DELETE test case] failed:', error)
      return NextResponse.json({ error: 'Failed to delete test case' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
