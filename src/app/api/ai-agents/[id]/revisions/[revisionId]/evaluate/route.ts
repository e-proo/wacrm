import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { validateTestCaseShape } from '@/lib/ai/runtime/builder-service'

/**
 * Safe simulation evaluator. It validates and records test-case
 * fixtures without calling a provider or writing business data.
 * Real model-backed evaluation is intentionally a later runtime
 * adapter; this endpoint still gives the builder a deterministic
 * safety gate today.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; revisionId: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:agentEvaluate:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id, revisionId } = await params
    const { data: cases, error: casesError } = await ctx.supabase
      .from('ai_agent_test_cases')
      .select('id, name, input_messages, assertions, is_required')
      .eq('account_id', ctx.accountId)
      .eq('agent_id', id)
    if (casesError) throw casesError
    const results = (cases ?? []).map((testCase) => {
      const checks = validateTestCaseShape(testCase)
      return {
        test_case_id: testCase.id,
        name: testCase.name,
        passed: checks.length === 0,
        simulated: true,
        tool_calls: [],
        response: null,
        violations: checks,
      }
    })
    const failedCases = results.filter((result) => !result.passed).length
    const status = failedCases === 0 ? 'passed' : 'failed'
    const { data, error } = await ctx.supabase
      .from('ai_agent_evaluation_runs')
      .insert({
        account_id: ctx.accountId,
        agent_id: id,
        revision_id: revisionId,
        status,
        results,
        total_cases: results.length,
        failed_cases: failedCases,
        created_by: ctx.userId,
        completed_at: new Date().toISOString(),
      })
      .select('id, status, results, total_cases, failed_cases, created_at, completed_at')
      .single()
    if (error) throw error
    return NextResponse.json({ evaluation: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
