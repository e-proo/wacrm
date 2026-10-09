import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

interface RouteContext { params: Promise<{ id: string }> }

async function loadLatestRevision(
  supabase: SupabaseClient,
  accountId: string,
  agentId: string,
): Promise<{ id: string; status: string } | null> {
  const { data: draft, error: draftError } = await supabase
    .from('ai_agent_revisions')
    .select('id, status')
    .eq('account_id', accountId)
    .eq('agent_id', agentId)
    .eq('status', 'draft')
    .order('revision_number', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (draftError) throw draftError
  if (draft) return draft as { id: string; status: string }
  const { data, error } = await supabase
    .from('ai_agent_revisions')
    .select('id, status')
    .eq('account_id', accountId)
    .eq('agent_id', agentId)
    .order('revision_number', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return (data as { id: string; status: string } | null) ?? null
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:agentKnowledge:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id: agentId } = await params
    const revision = await loadLatestRevision(ctx.supabase, ctx.accountId, agentId)

    const [basesRes, assignmentsRes] = await Promise.all([
      ctx.supabase
        .from('ai_knowledge_bases')
        .select('id, name, slug, description, scope, owner_agent_id, status, default_trust_level, updated_at')
        .eq('account_id', ctx.accountId)
        .order('name', { ascending: true }),
      revision
        ? ctx.supabase
            .from('ai_agent_knowledge_base_assignments')
            .select('knowledge_base_id, priority, enabled')
            .eq('account_id', ctx.accountId)
            .eq('agent_revision_id', revision.id)
        : Promise.resolve({ data: [], error: null }),
    ])
    if (basesRes.error) throw basesRes.error
    if (assignmentsRes.error) throw assignmentsRes.error

    const assigned = new Map(
      ((assignmentsRes.data ?? []) as Array<{ knowledge_base_id: string; priority: number; enabled: boolean }>)
        .map((a) => [a.knowledge_base_id, a]),
    )
    const bases = (basesRes.data ?? [])
      .filter((raw) => {
        const base = raw as { scope: string; owner_agent_id: string | null }
        return base.scope !== 'agent_private' || base.owner_agent_id === agentId
      })
      .map((raw) => {
        const base = raw as {
          id: string; name: string; slug: string; description: string | null; scope: string
          owner_agent_id: string | null; status: string; default_trust_level: string; updated_at: string
        }
        const a = assigned.get(base.id)
        return {
          knowledge_base_id: base.id,
          name: base.name,
          slug: base.slug,
          description: base.description,
          scope: base.scope,
          status: base.status,
          trust_level: base.default_trust_level,
          assigned: Boolean(a),
          enabled: a?.enabled ?? false,
          priority: a?.priority ?? 100,
          updated_at: base.updated_at,
        }
      })
    return NextResponse.json({ revision, knowledge_bases: bases })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request, { params }: RouteContext) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:agentKnowledgeWrite:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id: agentId } = await params
    const body = await request.json().catch(() => null) as {
      revisionId?: unknown
      assignments?: unknown
    } | null
    if (typeof body?.revisionId !== 'string' || !Array.isArray(body.assignments)) {
      return NextResponse.json({ error: 'revisionId and assignments are required' }, { status: 400 })
    }
    const { data: revision, error: revisionError } = await ctx.supabase
      .from('ai_agent_revisions')
      .select('id, status')
      .eq('account_id', ctx.accountId)
      .eq('agent_id', agentId)
      .eq('id', body.revisionId)
      .maybeSingle()
    if (revisionError) throw revisionError
    if (!revision) return NextResponse.json({ error: 'Revision not found' }, { status: 404 })
    if (revision.status !== 'draft') {
      return NextResponse.json({ error: 'Create a draft revision before changing knowledge assignments' }, { status: 409 })
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
      p_agent_revision_id: body.revisionId,
      p_assignments: assignments,
      p_actor_user_id: ctx.userId,
    })
    if (error) throw error
    return NextResponse.json({ ok: true, assigned: data ?? 0 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(_request: Request, { params }: RouteContext) {
  // Explicit admin shortcut: assign all ACTIVE KBs eligible for this agent.
  // This is not a runtime fallback; the result is persisted on the draft.
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:agentKnowledgeSync:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id: agentId } = await params
    const revision = await loadLatestRevision(ctx.supabase, ctx.accountId, agentId)
    if (!revision) return NextResponse.json({ error: 'Revision not found' }, { status: 404 })
    if (revision.status !== 'draft') {
      return NextResponse.json({ error: 'Create a draft revision before changing knowledge assignments' }, { status: 409 })
    }
    const { data: bases, error: basesError } = await ctx.supabase
      .from('ai_knowledge_bases')
      .select('id, scope, owner_agent_id')
      .eq('account_id', ctx.accountId)
      .eq('status', 'active')
    if (basesError) throw basesError
    const eligible = (bases ?? [])
      .filter((raw) => {
        const base = raw as { scope: string; owner_agent_id: string | null }
        return base.scope !== 'agent_private' || base.owner_agent_id === agentId
      })
      .map((raw) => ({ knowledge_base_id: (raw as { id: string }).id, priority: 100, enabled: true }))
    const { data, error } = await ctx.supabase.rpc('replace_ai_agent_knowledge_base_assignments', {
      p_account_id: ctx.accountId,
      p_agent_revision_id: revision.id,
      p_assignments: eligible,
      p_actor_user_id: ctx.userId,
    })
    if (error) throw error
    return NextResponse.json({ ok: true, synced: data ?? 0, total: eligible.length })
  } catch (err) {
    return toErrorResponse(err)
  }
}
