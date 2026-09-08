import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:agentBudgetRead:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params
    const { data, error } = await ctx.supabase
      .from('ai_agent_budget_policies')
      .select('id, agent_id, period, max_runs, max_input_tokens, max_output_tokens, soft_threshold, hard_action, fallback_agent_id, is_active, created_at, updated_at')
      .eq('account_id', ctx.accountId)
      .or(`agent_id.eq.${id},agent_id.is.null`)
      .order('period', { ascending: true })
    if (error) throw error
    return NextResponse.json({ policies: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:agentBudgetWrite:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params
    const body = (await request.json()) as {
      period?: 'daily' | 'monthly'
      maxRuns?: number
      maxInputTokens?: number
      maxOutputTokens?: number
      softThreshold?: number
      hardAction?: 'handoff' | 'pause' | 'cheaper_agent'
      fallbackAgentId?: string | null
      isActive?: boolean
    }
    if (!body.period) return NextResponse.json({ error: 'period is required' }, { status: 400 })
    const { data, error } = await ctx.supabase
      .from('ai_agent_budget_policies')
      .upsert({
        account_id: ctx.accountId,
        agent_id: id,
        period: body.period,
        max_runs: body.maxRuns ?? 1000,
        max_input_tokens: body.maxInputTokens ?? 1000000,
        max_output_tokens: body.maxOutputTokens ?? 500000,
        soft_threshold: body.softThreshold ?? 0.8,
        hard_action: body.hardAction ?? 'handoff',
        fallback_agent_id: body.fallbackAgentId ?? null,
        is_active: body.isActive ?? true,
        created_by: ctx.userId,
      }, { onConflict: 'account_id,agent_id,period' })
      .select('id, agent_id, period, max_runs, max_input_tokens, max_output_tokens, soft_threshold, hard_action, fallback_agent_id, is_active, created_at, updated_at')
      .single()
    if (error) throw error
    return NextResponse.json({ policy: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
