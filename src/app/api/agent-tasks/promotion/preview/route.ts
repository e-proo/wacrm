import { NextResponse } from 'next/server'
import { requireAgentCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { isAgentBuilderV2Configuration } from '@/lib/ai/tasks/builder-v2'
import { resolveServicePromotionAudience } from '@/lib/services/service-catalog/promotion-audience'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const headers = { 'Cache-Control': 'private, no-store, max-age=0' }

function deny(code: string, status: number) {
  return NextResponse.json({ error: code, code }, { status, headers })
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read-only Service Promotion campaign preview. This endpoint never creates
 * a Task, grants consent, enables a Pilot, or contacts WhatsApp.
 * No client-supplied tenant/actor is accepted.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireAgentCapability('agents.manage_tasks')
    await requireAgentCapability('agents.manage_outreach')
    const url = new URL(request.url)
    const serviceId = url.searchParams.get('serviceId')
    const agentId = url.searchParams.get('agentId')
    if (!serviceId || !UUID_RE.test(serviceId) ||
        !agentId || !UUID_RE.test(agentId)) {
      return deny('SERVICE_PROMOTION_PREVIEW_INVALID_INPUT', 400)
    }

    const db = supabaseAdmin()
    const [serviceResult, agentResult] = await Promise.all([
      db.from('services').select('id,name,status')
        .eq('account_id', ctx.accountId).eq('id', serviceId).maybeSingle(),
      db.from('ai_agents').select('id,name,status,published_revision_id')
        .eq('account_id', ctx.accountId).eq('id', agentId).maybeSingle(),
    ])
    if (serviceResult.error || agentResult.error) {
      throw serviceResult.error ?? agentResult.error
    }
    if (!serviceResult.data || serviceResult.data.status !== 'active') {
      return deny('SERVICE_PROMOTION_SERVICE_NOT_ACTIVE', 409)
    }
    const agent = agentResult.data
    if (!agent || agent.status !== 'active' || !agent.published_revision_id) {
      return deny('SERVICE_PROMOTION_AGENT_NOT_PUBLISHED', 409)
    }

    const { data: revision, error: revisionError } = await db
      .from('ai_agent_revisions')
      .select('id,status,operational_mode,outreach_policy')
      .eq('account_id', ctx.accountId)
      .eq('agent_id', agentId)
      .eq('id', agent.published_revision_id)
      .maybeSingle()
    if (revisionError) throw revisionError
    if (!revision || revision.status !== 'published') {
      return deny('SERVICE_PROMOTION_REVISION_NOT_PUBLISHED', 409)
    }
    const policy = object(revision.outreach_policy) ? revision.outreach_policy : {}
    const config = { operationalMode: revision.operational_mode, bindings: policy.bindings }
    if (!isAgentBuilderV2Configuration(config)) {
      return deny('SERVICE_PROMOTION_BUILDER_INVALID', 409)
    }
    const binding = config.bindings.find(item =>
      item.taskType === 'services.promotion' && item.taskTypeVersion === 1)
    if (!binding || binding.targetScope.requiredTagIds.length === 0 ||
        (binding.targetScope.serviceIds.length > 0 &&
          !binding.targetScope.serviceIds.includes(serviceId)) ||
        binding.targetScope.regionIds.length > 0 ||
        binding.targetScope.domainSelector !== null) {
      return deny('SERVICE_PROMOTION_BINDING_NOT_AUTHORIZED', 409)
    }

    let contactIds: string[]
    try {
      contactIds = await resolveServicePromotionAudience(db, {
        accountId: ctx.accountId,
        requiredTagIds: binding.targetScope.requiredTagIds,
        excludedTagIds: binding.targetScope.excludedTagIds,
        maxContacts: binding.maxTargets,
      })
    } catch (error) {
      if (error instanceof Error && /^SERVICE_PROMOTION_/.test(error.message)) {
        return deny(error.message, 409)
      }
      throw error
    }
    if (contactIds.length === 0) {
      return NextResponse.json({
        previewOnly: true,
        readyForLaunch: false,
        service: { id: serviceId, name: serviceResult.data.name },
        agent: { id: agentId, name: agent.name, revisionId: revision.id },
        audience: { total: 0, contacts: [], policyMax: binding.maxTargets },
        blockers: ['SERVICE_PROMOTION_AUDIENCE_EMPTY'],
      }, { headers })
    }

    const [{ data: contacts, error: contactsError },
      { data: controls, error: controlsError }] = await Promise.all([
      db.from('contacts').select('id,name,phone_normalized')
        .eq('account_id', ctx.accountId).in('id', contactIds)
        .limit(contactIds.length),
      db.from('ai_outreach_contact_controls')
        .select('contact_id,suppressed_until')
        .eq('account_id', ctx.accountId).eq('channel', 'whatsapp')
        .in('state', ['opted_out', 'blocked']).in('contact_id', contactIds)
        .limit(contactIds.length * 2),
    ])
    if (contactsError || controlsError) throw contactsError ?? controlsError
    const now = Date.now()
    const suppressed = new Set((controls ?? [])
      .filter(row => !row.suppressed_until ||
        !Number.isFinite(Date.parse(row.suppressed_until)) ||
        Date.parse(row.suppressed_until) > now)
      .map(row => row.contact_id))
    const contactMap = new Map((contacts ?? []).map(c => [c.id, c]))
    const candidates = contactIds.map(id => {
      const row = contactMap.get(id)
      const reason = !row
        ? 'contact_missing'
        : suppressed.has(id)
          ? 'opted_out_or_blocked'
          : !/^[0-9]{8,15}$/.test(String(row.phone_normalized ?? ''))
            ? 'invalid_phone'
            : 'consent_and_transport_not_verified'
      return { id, name: row?.name ?? null, reason }
    })
    const blockers = [
      'OPERATOR_APPROVAL_REQUIRED',
      'WHATSAPP_CONSENT_UNVERIFIED',
      'CONNECTION_AND_TEMPLATE_NOT_VERIFIED',
    ]
    return NextResponse.json({
      previewOnly: true,
      readyForLaunch: false,
      service: { id: serviceId, name: serviceResult.data.name },
      agent: { id: agentId, name: agent.name, revisionId: revision.id },
      audience: {
        total: candidates.length,
        contacts: candidates,
        policyMax: binding.maxTargets,
        filteredByOptOut: candidates.filter(c => c.reason === 'opted_out_or_blocked').length,
      },
      blockers,
    }, { headers })
  } catch (error) {
    return toErrorResponse(error)
  }
}
