import { createHash } from 'node:crypto'
import { loadAccountRuntimePolicy } from '@/lib/ai/runtime/runtime-policy'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isAgentBuilderV2Configuration, type AgentBuilderTaskBinding } from '@/lib/ai/tasks/builder-v2'
import { deferredTestOpenWATaskReason } from '@/lib/ai/tasks/test-openwa-task-admission'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'
import { resolveServicePromotionAudience } from './promotion-audience'
import { loadServicePromotionContext, promotionSnapshotName } from './agent-task'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const PROMOTION_REVIEW_TTL_MS = 10 * 60_000
export type PromotionProvider = 'meta_cloud' | 'openwa'

export interface ServicePromotionCampaignReview {
  service: { id: string; name: string; publicDescription: string | null }
  agent: { id: string; name: string; revisionId: string }
  connection: { id: string; name: string; provider: PromotionProvider }
  audience: {
    ids: string[]
    contacts: Array<{ id: string; name: string | null; phone: string | null; reason: string | null }>
    count: number
    max: number
    requiredTags: string[]
    excludedTags: string[]
  }
  template: { name: string; language: string; status: string; id: string | null } | null
  firstMessage: { kind: 'template' | 'text'; body: string }
  blockers: string[]
  fingerprint: string
  binding: AgentBuilderTaskBinding
}

export class ServicePromotionReviewError extends Error {
  constructor(public readonly code: string, public readonly status = 409) {
    super(code)
    this.name = 'ServicePromotionReviewError'
  }
}

function validUuid(value: string): boolean { return UUID_RE.test(value) }

export function assertPromotionReviewFresh(input: {
  fingerprint: string
  reviewedAt: string
  actualFingerprint: string
  now?: number
}): void {
  const when = Date.parse(input.reviewedAt)
  const now = input.now ?? Date.now()
  if (!/^[a-f0-9]{64}$/.test(input.fingerprint) ||
      !Number.isFinite(when) || when > now + 30_000 ||
      now - when > PROMOTION_REVIEW_TTL_MS) {
    throw new ServicePromotionReviewError('SERVICE_PROMOTION_REVIEW_EXPIRED')
  }
  if (input.fingerprint !== input.actualFingerprint) {
    throw new ServicePromotionReviewError('SERVICE_PROMOTION_REVIEW_STALE')
  }
}

export async function inspectServicePromotionCampaign(
  db: SupabaseClient,
  input: { accountId: string; serviceId: string; agentId: string; connectionId: string },
): Promise<ServicePromotionCampaignReview> {
  if (![input.accountId, input.serviceId, input.agentId, input.connectionId].every(validUuid)) {
    throw new ServicePromotionReviewError('SERVICE_PROMOTION_SELECTION_INVALID', 400)
  }
  const [serviceContext, agentResult, connectionResult] = await Promise.all([
    loadServicePromotionContext(db, { accountId: input.accountId, serviceId: input.serviceId }),
    db.from('ai_agents').select('id,name,status,published_revision_id')
      .eq('account_id', input.accountId).eq('id', input.agentId).maybeSingle(),
    db.from('whatsapp_connections')
      .select('id,display_name,provider,status,session_id,archived_at')
      .eq('account_id', input.accountId).eq('id', input.connectionId).maybeSingle(),
  ])
  if (agentResult.error || connectionResult.error) {
    throw agentResult.error ?? connectionResult.error
  }
  const agent = agentResult.data
  if (!agent || agent.status !== 'active' || !agent.published_revision_id) {
    throw new ServicePromotionReviewError('SERVICE_PROMOTION_AGENT_NOT_PUBLISHED')
  }
  const connection = connectionResult.data
  if (!connection || connection.archived_at ||
      !(connection.provider === 'meta_cloud' && connection.status === 'connected' ||
        connection.provider === 'openwa' &&
          ['ready', 'connected'].includes(connection.status) && connection.session_id)) {
    throw new ServicePromotionReviewError('SERVICE_PROMOTION_CONNECTION_UNAVAILABLE')
  }
  const provider = connection.provider as PromotionProvider

  const { data: revision, error: revisionError } = await db.from('ai_agent_revisions')
    .select('id,status,operational_mode,outreach_policy')
    .eq('account_id', input.accountId).eq('agent_id', input.agentId)
    .eq('id', agent.published_revision_id).maybeSingle()
  if (revisionError) throw revisionError
  if (!revision || revision.status !== 'published') {
    throw new ServicePromotionReviewError('SERVICE_PROMOTION_REVISION_NOT_PUBLISHED')
  }
  const config = {
    operationalMode: revision.operational_mode,
    bindings: revision.outreach_policy && typeof revision.outreach_policy === 'object' &&
      !Array.isArray(revision.outreach_policy)
      ? (revision.outreach_policy as Record<string, unknown>).bindings : undefined,
  }
  if (!isAgentBuilderV2Configuration(config)) {
    throw new ServicePromotionReviewError('SERVICE_PROMOTION_BUILDER_INVALID')
  }
  const binding = config.bindings.find(item =>
    item.taskType === 'services.promotion' && item.taskTypeVersion === 2)
  // A published Revision N is unrelated to the Task Type V2 version. Keep
  // mismatched Task versions distinct from a correctly published V2 with
  // an incomplete audience. Never bypass the mandatory frozen tag cohort.
  if (!binding) {
    throw new ServicePromotionReviewError('SERVICE_PROMOTION_V2_BINDING_REQUIRED')
  }
  if (binding.targetScope.requiredTagIds.length === 0) {
    throw new ServicePromotionReviewError('SERVICE_PROMOTION_SEGMENT_REQUIRED')
  }
  if (binding.targetScope.serviceIds.length > 0 &&
      !binding.targetScope.serviceIds.includes(input.serviceId)) {
    throw new ServicePromotionReviewError('SERVICE_PROMOTION_SERVICE_SCOPE_DENIED')
  }
  if (binding.targetScope.regionIds.length > 0 ||
      binding.targetScope.domainSelector !== null) {
    throw new ServicePromotionReviewError('SERVICE_PROMOTION_SELECTOR_UNSUPPORTED')
  }
  if (binding.approvalMode === 'none') {
    throw new ServicePromotionReviewError('SERVICE_PROMOTION_APPROVAL_REQUIRED')
  }

  const ids = await resolveServicePromotionAudience(db, {
    accountId: input.accountId,
    requiredTagIds: binding.targetScope.requiredTagIds,
    excludedTagIds: binding.targetScope.excludedTagIds,
    maxContacts: binding.maxTargets,
  })
  const blockers: string[] = []
  if (ids.length === 0) blockers.push('SERVICE_PROMOTION_AUDIENCE_EMPTY')
  const [runtime, worker] = await Promise.all([
    loadAccountRuntimePolicy(db, input.accountId),
    db.from('ai_runtime_policies').select('task_worker_enabled')
      .eq('account_id', input.accountId).maybeSingle(),
  ])
  if (worker.error) throw worker.error
  if (runtime.killSwitch || !runtime.multiAgentEnabled ||
      !runtime.recoveryWorkerEnabled || !runtime.nativeToolsEnabled ||
      !runtime.proposalToolsEnabled || !runtime.outboundTaskDeliveryEnabled) {
    blockers.push('SERVICE_PROMOTION_RUNTIME_NOT_READY')
  }
  if (worker.data?.task_worker_enabled === false) {
    blockers.push('SERVICE_PROMOTION_WORKER_PAUSED')
  }
  try { promotionSnapshotName(serviceContext.service.name) }
  catch { blockers.push('SERVICE_PROMOTION_MESSAGE_FACTS_INVALID') }

  let contacts: ServicePromotionCampaignReview['audience']['contacts'] = []
  if (ids.length) {
    const [{ data, error }, { data: controls, error: controlError }] = await Promise.all([
      db.from('contacts').select('id,name,phone,phone_normalized')
        .eq('account_id', input.accountId).in('id', ids).limit(ids.length),
      db.from('ai_outreach_contact_controls')
        .select('contact_id,suppressed_until')
        .eq('account_id', input.accountId).eq('channel', 'whatsapp')
        .in('state', ['opted_out', 'blocked']).in('contact_id', ids)
        .limit(ids.length * 2),
    ])
    if (error || controlError) throw error ?? controlError
    const contactMap = new Map((data ?? []).map(row => [String(row.id), row]))
    const suppressed = new Set((controls ?? [])
      .filter(row => !row.suppressed_until || Date.parse(row.suppressed_until) > Date.now())
      .map(row => row.contact_id))
    contacts = ids.map(id => {
      const row = contactMap.get(id)
      const phone = String(row?.phone_normalized ?? row?.phone ?? '').replace(/^\+/, '')
      const reason = !row ? 'contact_missing' : suppressed.has(id) ? 'opted_out_or_blocked'
        : !/^[1-9][0-9]{7,14}$/.test(phone) ? 'invalid_phone' : null
      if (reason) blockers.push('SERVICE_PROMOTION_CONTACT_BLOCKED')
      return { id, name: row?.name ?? null, phone: phone || null, reason }
    })
  }
  const { data: guard, error: guardError } = await db
    .from('whatsapp_connection_guardrails')
    .select('manual_paused,circuit_open_until,pilot_enabled')
    .eq('account_id', input.accountId).eq('connection_id', input.connectionId)
    .maybeSingle()
  if (guardError) throw guardError
  if (guard?.manual_paused || guard?.circuit_open_until &&
      Date.parse(guard.circuit_open_until) > Date.now()) {
    blockers.push('SERVICE_PROMOTION_CONNECTION_PAUSED')
  }
  let template: ServicePromotionCampaignReview['template'] = null
  let body: string
  if (provider === 'meta_cloud') {
    const { data, error } = await db.from('message_templates')
      .select('id,name,language,status,body_text,category')
      .eq('account_id', input.accountId)
      .eq('name', 'service_promotion_v1')
      .eq('language', 'ar')
      .eq('status', 'APPROVED')
      .limit(2)
    if (error) throw error
    const row = data?.length === 1 ? data[0] : null
    if (!row || String(row.category ?? '').toUpperCase() !== 'MARKETING' ||
        !String(row.body_text ?? '').includes('{{1}}') ||
        /\{\{(?:[2-9]|[1-9][0-9]+)\}\}/.test(String(row.body_text ?? ''))) {
      blockers.push('SERVICE_PROMOTION_APPROVED_TEMPLATE_MISSING')
    }
    template = { id: row?.id ?? null, name: 'service_promotion_v1',
      language: 'ar', status: row ? 'APPROVED_LOCAL' : 'NOT_VERIFIED' }
    // Local approval cannot prove Meta connection-specific publication.
    body = row?.body_text?.replaceAll('{{1}}', serviceContext.service.name) ??
      'قالب Meta service_promotion_v1 (المتغير: اسم الخدمة)'
  } else {
    if (!isOpenWATestProject()) {
      blockers.push('SERVICE_PROMOTION_OPENWA_TEST_ONLY')
    } else if (!guard || guard.pilot_enabled !== true) {
      blockers.push('SERVICE_PROMOTION_OPENWA_PILOT_REQUIRED')
    } else if (ids.length > 0) {
      const deferral = await deferredTestOpenWATaskReason({
        db, accountId: input.accountId, connectionId: input.connectionId, contactIds: ids,
      })
      if (deferral) blockers.push('SERVICE_PROMOTION_' + deferral.toUpperCase())
    }
    body = [
      'مرحبًا، نود تعريفك بخدمة ' + serviceContext.service.name + ' المتاحة لدينا.',
      'إذا رغبت في التفاصيل أو كانت الخدمة مناسبة لاحتياجك، يمكنك الرد هنا وسيساعدك فريقنا.',
      'لإيقاف هذه الرسائل، أرسل كلمة «إيقاف».',
    ].join('\n')
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({
    accountId: input.accountId,
    service: serviceContext.service,
    agentId: agent.id, revisionId: revision.id,
    connectionId: connection.id, provider,
    requiredTags: [...binding.targetScope.requiredTagIds].sort(),
    excludedTags: [...binding.targetScope.excludedTagIds].sort(),
    maxTargets: binding.maxTargets, ids,
    template,
    firstMessage: body,
    contacts,
  })).digest('hex')
  return {
    service: { id: serviceContext.serviceId, name: serviceContext.service.name,
      publicDescription: serviceContext.service.publicDescription },
    agent: { id: agent.id, name: agent.name, revisionId: revision.id },
    connection: { id: connection.id, name: connection.display_name || provider, provider },
    audience: { ids, contacts, count: ids.length, max: binding.maxTargets,
      requiredTags: [...binding.targetScope.requiredTagIds],
      excludedTags: [...binding.targetScope.excludedTagIds] },
    template,
    firstMessage: { kind: provider === 'meta_cloud' ? 'template' : 'text', body },
    blockers: [...new Set(blockers)],
    fingerprint,
    binding,
  }
}
