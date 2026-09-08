import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { validateTestCaseShape } from '@/lib/ai/runtime/builder-service'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:agentTestsList:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params
    const { data, error } = await ctx.supabase
      .from('ai_agent_test_cases')
      .select('id, account_id, agent_id, name, plane, input_messages, assertions, is_required, created_at')
      .eq('account_id', ctx.accountId)
      .eq('agent_id', id)
      .order('created_at', { ascending: true })
    if (error) throw error
    return NextResponse.json({ testCases: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:agentTestCreate:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params
    const body = (await request.json()) as {
      name?: string
      plane?: 'customer' | 'admin'
      input_messages?: unknown
      assertions?: unknown
      is_required?: boolean
    }
    const checks = validateTestCaseShape(body)
    if (checks.some((check) => check.severity === 'error')) return NextResponse.json({ ok: false, checks }, { status: 400 })
    const { data, error } = await ctx.supabase
      .from('ai_agent_test_cases')
      .insert({
        account_id: ctx.accountId,
        agent_id: id,
        name: body.name,
        plane: body.plane ?? 'customer',
        input_messages: body.input_messages,
        assertions: body.assertions,
        is_required: body.is_required ?? false,
        created_by: ctx.userId,
      })
      .select('id, account_id, agent_id, name, plane, input_messages, assertions, is_required, created_at')
      .single()
    if (error) throw error
    return NextResponse.json({ testCase: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
