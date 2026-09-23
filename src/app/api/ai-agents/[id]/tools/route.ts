import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { listCurrentToolDefinitions } from '@/lib/ai/tools/platform/runtime-tool-compat'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:agentTools:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params
    const { data, error } = await ctx.supabase
      .from('ai_agent_revisions')
      .select('id, revision_number, status, ai_agent_tool_grants(id, tool_key, tool_version, permission, constraints)')
      .eq('account_id', ctx.accountId)
      .eq('agent_id', id)
      .order('revision_number', { ascending: false })
    if (error) throw error
    return NextResponse.json({ registry: listCurrentToolDefinitions(), revisions: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
