import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAccountRuntimePolicy } from '@/lib/ai/runtime/runtime-policy'

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:aiRuntimePolicyRead:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const policy = await loadAccountRuntimePolicy(ctx.supabase, ctx.accountId)
    return NextResponse.json({ policy })
  } catch (err) {
    return toErrorResponse(err)
  }
}

interface UpdateBody {
  multiAgentEnabled?: boolean
  adminPlaneEnabled?: boolean
  nativeToolsEnabled?: boolean
  proposalToolsEnabled?: boolean
  recoveryWorkerEnabled?: boolean
  killSwitch?: boolean
  maxRunsPerMinute?: number
  dailyInputTokenBudget?: number | null
  dailyOutputTokenBudget?: number | null
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:aiRuntimePolicyWrite:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    let body: UpdateBody
    try {
      body = (await request.json()) as UpdateBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const boolKeys: Array<keyof UpdateBody> = [
      'multiAgentEnabled',
      'adminPlaneEnabled',
      'nativeToolsEnabled',
      'proposalToolsEnabled',
      'recoveryWorkerEnabled',
      'killSwitch',
    ]
    for (const key of boolKeys) {
      if (body[key] !== undefined && typeof body[key] !== 'boolean') {
        return NextResponse.json({ error: `${key} must be boolean` }, { status: 400 })
      }
    }
    if (
      body.maxRunsPerMinute !== undefined &&
      (!Number.isInteger(body.maxRunsPerMinute) || body.maxRunsPerMinute < 1 || body.maxRunsPerMinute > 1000)
    ) {
      return NextResponse.json({ error: 'maxRunsPerMinute must be an integer from 1 to 1000' }, { status: 400 })
    }
    for (const [name, value] of [
      ['dailyInputTokenBudget', body.dailyInputTokenBudget],
      ['dailyOutputTokenBudget', body.dailyOutputTokenBudget],
    ] as const) {
      if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) {
        return NextResponse.json({ error: `${name} must be null or a non-negative safe integer` }, { status: 400 })
      }
    }

    // Read current row so PUT can be partial without accidentally enabling
    // dangerous features. Missing rows start with every dangerous switch off.
    const current = await loadAccountRuntimePolicy(ctx.supabase, ctx.accountId)
    const { error } = await ctx.supabase
      .from('ai_runtime_policies')
      .upsert(
        {
          account_id: ctx.accountId,
          multi_agent_enabled: body.multiAgentEnabled ?? current.multiAgentEnabled,
          admin_plane_enabled: body.adminPlaneEnabled ?? current.adminPlaneEnabled,
          native_tools_enabled: body.nativeToolsEnabled ?? current.nativeToolsEnabled,
          proposal_tools_enabled: body.proposalToolsEnabled ?? current.proposalToolsEnabled,
          recovery_worker_enabled: body.recoveryWorkerEnabled ?? current.recoveryWorkerEnabled,
          kill_switch: body.killSwitch ?? current.killSwitch,
          max_runs_per_minute: body.maxRunsPerMinute ?? current.maxRunsPerMinute,
          daily_input_token_budget:
            body.dailyInputTokenBudget === undefined
              ? current.dailyInputTokenBudget
              : body.dailyInputTokenBudget,
          daily_output_token_budget:
            body.dailyOutputTokenBudget === undefined
              ? current.dailyOutputTokenBudget
              : body.dailyOutputTokenBudget,
          updated_by: ctx.userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'account_id' },
      )
    if (error) throw error
    const policy = await loadAccountRuntimePolicy(ctx.supabase, ctx.accountId)
    return NextResponse.json({ policy })
  } catch (err) {
    return toErrorResponse(err)
  }
}
