import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { supabase, accountId } = await getCurrentAccount()
    const [{ data: base, error }, { data: services, error: servicesError }] = await Promise.all([
      supabase
        .from('ai_knowledge_bases')
        .select('id, name, slug, description, scope, owner_agent_id, status, default_trust_level, created_at, updated_at')
        .eq('account_id', accountId)
        .eq('id', id)
        .maybeSingle(),
      supabase
        .from('ai_knowledge_base_services')
        .select('service_id')
        .eq('account_id', accountId)
        .eq('knowledge_base_id', id),
    ])
    if (error) throw error
    if (servicesError) throw servicesError
    if (!base) return NextResponse.json({ error: 'Knowledge base not found' }, { status: 404 })
    return NextResponse.json({ ...base, service_ids: (services ?? []).map((row) => row.service_id) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb-base-update:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

    const patch: Record<string, unknown> = { updated_by: userId }
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim()
    if (typeof body.description === 'string' || body.description === null) patch.description = body.description
    if (body.status === 'draft' || body.status === 'active' || body.status === 'archived') patch.status = body.status
    if (body.default_trust_level === 'admin_verified' || body.default_trust_level === 'internal' || body.default_trust_level === 'external' || body.default_trust_level === 'untrusted') {
      patch.default_trust_level = body.default_trust_level
    }

    const { data: base, error } = await supabase
      .from('ai_knowledge_bases')
      .update(patch)
      .eq('account_id', accountId)
      .eq('id', id)
      .select('id')
      .maybeSingle()
    if (error) throw error
    if (!base) return NextResponse.json({ error: 'Knowledge base not found' }, { status: 404 })

    if (Array.isArray(body.service_ids)) {
      const serviceIds = [...new Set(body.service_ids.filter((v): v is string => typeof v === 'string'))]
      if (serviceIds.length > 0) {
        const { data: ownedServices, error: ownedError } = await supabase
          .from('services')
          .select('id')
          .eq('account_id', accountId)
          .in('id', serviceIds)
        if (ownedError) throw ownedError
        if ((ownedServices ?? []).length !== serviceIds.length) {
          return NextResponse.json(
            { error: 'One or more service_ids do not belong to this account' },
            { status: 400 },
          )
        }
      }
      const { error: deleteError } = await supabase
        .from('ai_knowledge_base_services')
        .delete()
        .eq('account_id', accountId)
        .eq('knowledge_base_id', id)
      if (deleteError) throw deleteError
      if (serviceIds.length > 0) {
        const { error: insertError } = await supabase
          .from('ai_knowledge_base_services')
          .insert(serviceIds.map((serviceId) => ({
            account_id: accountId,
            knowledge_base_id: id,
            service_id: serviceId,
          })))
        if (insertError) throw insertError
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
