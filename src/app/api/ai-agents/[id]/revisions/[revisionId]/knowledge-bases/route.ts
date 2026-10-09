import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

async function assertRevisionOwnership(input: {
  supabase: Awaited<ReturnType<typeof getCurrentAccount>>['supabase']
  accountId: string
  agentId: string
  revisionId: string
}) {
  const { data, error } = await input.supabase
    .from('ai_agent_revisions')
    .select('id, status')
    .eq('account_id', input.accountId)
    .eq('agent_id', input.agentId)
    .eq('id', input.revisionId)
    .maybeSingle()
  if (error) throw error
  return data as { id: string; status: string } | null
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; revisionId: string }> },
) {
  try {
    const { id, revisionId } = await params
    const ctx = await getCurrentAccount()
    const revision = await assertRevisionOwnership({
      supabase: ctx.supabase,
      accountId: ctx.accountId,
      agentId: id,
      revisionId,
    })
    if (!revision) return NextResponse.json({ error: 'Revision not found' }, { status: 404 })
    const { data, error } = await ctx.supabase
      .from('ai_agent_knowledge_base_assignments')
      .select('knowledge_base_id, priority, enabled, ai_knowledge_bases(id, name, slug, scope, status)')
      .eq('account_id', ctx.accountId)
      .eq('agent_revision_id', revisionId)
      .order('priority', { ascending: true })
    if (error) throw error
    return NextResponse.json({ assignments: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; revisionId: string }> },
) {
  try {
    const { id, revisionId } = await params
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`ai-agent-kb-assign:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const revision = await assertRevisionOwnership({
      supabase: ctx.supabase,
      accountId: ctx.accountId,
      agentId: id,
      revisionId,
    })
    if (!revision) return NextResponse.json({ error: 'Revision not found' }, { status: 404 })
    if (revision.status !== 'draft') {
      return NextResponse.json({ error: 'Published revision knowledge assignments are immutable' }, { status: 409 })
    }
    const body = await request.json().catch(() => null) as { assignments?: unknown } | null
    if (!Array.isArray(body?.assignments)) {
      return NextResponse.json({ error: 'assignments must be an array' }, { status: 400 })
    }
    const assignments = body.assignments.map((raw) => {
      const row = raw as Record<string, unknown>
      if (typeof row.knowledge_base_id !== 'string') throw new Error('knowledge_base_id is required')
      return {
        knowledge_base_id: row.knowledge_base_id,
        priority: typeof row.priority === 'number' && Number.isInteger(row.priority) ? row.priority : 100,
        enabled: row.enabled !== false,
      }
    })
    const { data, error } = await ctx.supabase.rpc('replace_ai_agent_knowledge_base_assignments', {
      p_account_id: ctx.accountId,
      p_agent_revision_id: revisionId,
      p_assignments: assignments,
      p_actor_user_id: ctx.userId,
    })
    if (error) throw error
    return NextResponse.json({ success: true, assigned: data ?? 0 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
