import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { createKnowledgeBase } from '@/lib/ai/knowledge-v2'

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('ai_knowledge_bases')
      .select('id, name, slug, description, scope, owner_agent_id, status, default_trust_level, created_at, updated_at')
      .eq('account_id', accountId)
      .order('updated_at', { ascending: false })
    if (error) throw error
    return NextResponse.json({ knowledge_bases: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb-base:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const body = await request.json().catch(() => null) as {
      name?: unknown
      slug?: unknown
      description?: unknown
      scope?: unknown
      owner_agent_id?: unknown
      default_trust_level?: unknown
    } | null
    if (typeof body?.name !== 'string' || !body.name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }
    const scope = body.scope === 'agent_private' || body.scope === 'service' ? body.scope : 'shared'
    const ownerAgentId = typeof body.owner_agent_id === 'string' ? body.owner_agent_id : null
    if (scope === 'agent_private') {
      if (!ownerAgentId) {
        return NextResponse.json({ error: 'owner_agent_id is required for agent_private knowledge bases' }, { status: 400 })
      }
      const { data: ownerAgent, error: ownerError } = await supabase
        .from('ai_agents')
        .select('id')
        .eq('account_id', accountId)
        .eq('id', ownerAgentId)
        .maybeSingle()
      if (ownerError) throw ownerError
      if (!ownerAgent) {
        return NextResponse.json({ error: 'Owner agent not found in this account' }, { status: 400 })
      }
    }
    const trust = body.default_trust_level === 'admin_verified'
      || body.default_trust_level === 'external'
      || body.default_trust_level === 'untrusted'
      ? body.default_trust_level
      : 'internal'
    const created = await createKnowledgeBase({
      db: supabase,
      accountId,
      userId,
      name: body.name,
      slug: typeof body.slug === 'string' ? body.slug : undefined,
      description: typeof body.description === 'string' ? body.description : null,
      scope,
      ownerAgentId,
      defaultTrustLevel: trust,
    })
    return NextResponse.json({ success: true, ...created }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
