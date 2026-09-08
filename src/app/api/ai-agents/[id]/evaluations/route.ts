import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:agentEvaluationsList:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params
    const { data, error } = await ctx.supabase
      .from('ai_agent_evaluation_runs')
      .select('id, revision_id, status, results, total_cases, failed_cases, input_tokens, output_tokens, created_at, completed_at')
      .eq('account_id', ctx.accountId)
      .eq('agent_id', id)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw error
    return NextResponse.json({ evaluations: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
