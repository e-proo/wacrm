import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import {
  loadSupplierCoverageRoute, validSupplierCoverageRoute, assertSupplierRouteMatchesAttributes,
  type SupplierCoverageRoute,
} from './supplier-request-route'
import { defineAgentTaskType } from '@/lib/ai/tasks/contracts'
import type { AgentTaskCompletionPolicy } from '@/lib/ai/tasks/completion-policy'
import type {
  AgentTaskModule,
  AgentTaskTargetCandidate,
  AgentTaskTargetResolver,
} from '@/lib/ai/tasks/target-resolution'
import type {
  AgentTaskOutboundMessageCandidate,
  AgentTaskOutboundMessagePolicy,
  AgentTaskOutboundPolicyContext,
} from '@/lib/ai/tasks/outbound-policy'
import {
  normalizeCoverageAttributes,
  type CoverageAttributes,
  type CoverageMethod,
} from './attributes'
import { parseExplicitCoverageContactIds } from './selected-targets'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const SOURCEABLE_REQUEST_STATUSES = new Set([
  'active',
  'partially_reserved',
])

const SUPPLIER_HISTORY_STATUSES = [
  'active',
  'partially_reserved',
  'fully_reserved',
  'fulfilled',
  'expired',
] as const

const STATUS_RANK: Record<(typeof SUPPLIER_HISTORY_STATUSES)[number], number> = {
  active: 0,
  partially_reserved: 1,
  fully_reserved: 2,
  fulfilled: 3,
  expired: 4,
}

export const COVERAGE_SOURCING_TASK_TYPE = defineAgentTaskType({
  key: 'coverage.sourcing',
  version: 1,
  domain: 'coverage',
  title: 'Coverage sourcing',
  description:
    'Find deterministic supplier candidates for an active Coverage Request and continue supplier replies through the same Agent Task.',
  requiredAgentCapabilities: ['coverage.sourcing'],
  allowedChannels: ['whatsapp'],
  targetResolver: 'coverage.supplier_candidates',
  allowedTools: [
    { key: 'coverage.get_rates', version: 1 },
    { key: 'coverage.propose_offer', version: 2 },
  ],
  requiredTaskApproval: 'task',
  followupPolicy: {
    maxFollowups: 1,
    minimumIntervalMinutes: 60,
    maximumIntervalMinutes: 2880,
    stopOnReply: true,
    stopOnOptOut: true,
    stopOnBusinessOutcome: true,
  },
  maxTargets: 100,
  completionPolicy: {
    key: 'coverage.sourcing_completion',
    version: 1,
    config: {
      businessOutcomeEvent: 'coverage.offer.approved',
      sourceRequestStatus: ['active', 'partially_reserved'],
      completionRule: 'required_amount_satisfied_or_targets_terminal',
    },
  },
  messagePolicy: {
    key: 'coverage.sourcing_message',
    version: 1,
    config: {
      templateName: 'coverage_sourcing_supplier_v1',
      templateLanguage: 'ar',
    },
  },
})

// Version 1 is frozen for existing Meta-first Tasks. Version 2 adds
// account-scoped provider-aware outreach without changing old Task behavior.
export const COVERAGE_SOURCING_TASK_TYPE_V2 = defineAgentTaskType({
  ...COVERAGE_SOURCING_TASK_TYPE,
  version: 2,
  messagePolicy: {
    ...COVERAGE_SOURCING_TASK_TYPE.messagePolicy,
    version: 2,
    config: {
      ...COVERAGE_SOURCING_TASK_TYPE.messagePolicy.config,
      // This six-variable Meta template must be explicitly approved by Meta.
      // The amount-only v1 template is insufficient for supplier sourcing.
      templateName: 'coverage_sourcing_supplier_v2',
    },
  },
})

interface CoverageRequestRow {
  id: string
  service_id: string
  requester_contact_id: string
  requested_amount: string | number
  reserved_amount: string | number
  fulfilled_amount: string | number
  currency: string
  attributes: Record<string, unknown> | null
  status: string
}

interface CoverageOfferHistoryRow {
  provider_contact_id: string
  attributes: Record<string, unknown> | null
  status: (typeof SUPPLIER_HISTORY_STATUSES)[number]
  created_at: string
}

export interface CoverageSourcingRequestSnapshot {
  requestId: string
  serviceId: string
  requestedAmount: string
  remainingAmount: string
  currency: string
  attributes: CoverageAttributes
  route?: SupplierCoverageRoute
  serviceName?: string
}

export interface CoverageSourcingTaskContext {
  coverageRequestId: string
  request: CoverageSourcingRequestSnapshot
}

export function parseCoverageSourcingRequestId(
  taskContext: Readonly<Record<string, unknown>>,
): string {
  const requestId = taskContext.coverageRequestId
  if (typeof requestId !== 'string' || !UUID_RE.test(requestId)) {
    throw new Error('COVERAGE_SOURCING_REQUEST_ID_REQUIRED')
  }
  return requestId
}

function positiveRemaining(request: CoverageRequestRow): number {
  return (
    Number(request.requested_amount) -
    Number(request.reserved_amount ?? 0) -
    Number(request.fulfilled_amount ?? 0)
  )
}

function methodCompatible(a: CoverageMethod, b: CoverageMethod): boolean {
  return a === 'any' || b === 'any' || a === b
}

function nullableEqualWhenBothPresent(
  first: string | null,
  second: string | null,
): boolean {
  return !first || !second || first === second
}

/**
 * Coverage supply is anti-parallel to a request:
 *
 * supplier OFFER pay leg     == requester REQUEST receive leg
 * supplier OFFER receive leg == requester REQUEST pay leg
 *
 * Missing legacy region ids behave as an unscored wildcard; methods use the
 * explicit any wildcard from the Coverage domain contract.
 */
export function coverageOfferMatchesSourcingRequest(
  request: CoverageAttributes,
  offer: CoverageAttributes,
): boolean {
  if (request.coverage_scope !== offer.coverage_scope) return false

  if (
    request.coverage_scope === 'international' &&
    request.coverage_country &&
    offer.coverage_country &&
    request.coverage_country !== offer.coverage_country
  ) {
    return false
  }

  return (
    nullableEqualWhenBothPresent(
      request.receive_region_id,
      offer.pay_region_id,
    ) &&
    nullableEqualWhenBothPresent(
      request.pay_region_id,
      offer.receive_region_id,
    ) &&
    methodCompatible(request.receive_method, offer.pay_method) &&
    methodCompatible(request.pay_method, offer.receive_method)
  )
}

function reverseTimestamp(timestamp: string): string {
  const parsed = Date.parse(timestamp)
  const value = Number.isFinite(parsed) ? parsed : 0
  return String(9_999_999_999_999 - value).padStart(13, '0')
}

export function supplierHistorySortKey(
  row: Pick<CoverageOfferHistoryRow, 'status' | 'created_at'>,
): string {
  return (
    String(STATUS_RANK[row.status]).padStart(2, '0') +
    ':' +
    reverseTimestamp(row.created_at)
  )
}

export async function loadCoverageSourcingTaskContext(
  db: SupabaseClient,
  input: { accountId: string; coverageRequestId: string },
): Promise<CoverageSourcingTaskContext> {
  if (!UUID_RE.test(input.coverageRequestId)) {
    throw new Error('COVERAGE_SOURCING_REQUEST_ID_REQUIRED')
  }

  const { data, error } = await db
    .from('coverage_requests')
    .select(
      'id, service_id, requester_contact_id, requested_amount, reserved_amount, fulfilled_amount, currency, attributes, status',
    )
    .eq('account_id', input.accountId)
    .eq('id', input.coverageRequestId)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error('COVERAGE_SOURCING_REQUEST_NOT_FOUND')

  const request = data as CoverageRequestRow
  if (!SOURCEABLE_REQUEST_STATUSES.has(request.status)) {
    throw new Error('COVERAGE_SOURCING_REQUEST_NOT_SOURCEABLE')
  }

  const remaining = positiveRemaining(request)
  if (!(remaining > 0)) {
    throw new Error('COVERAGE_SOURCING_REQUEST_ALREADY_SATISFIED')
  }

  const attributes = (() => {
    const normalized = normalizeCoverageAttributes(request.attributes)
    if (!normalized.ok) throw new Error('COVERAGE_SOURCING_REQUEST_ATTRIBUTES_INVALID')
    return normalized.normalized
  })()
  const route = await loadSupplierCoverageRoute(db,input.accountId,attributes)
  const { data: service, error: serviceError } = await db.from('services')
    .select('name').eq('account_id',input.accountId).eq('id',request.service_id).maybeSingle()
  if (serviceError) throw serviceError
  if (!service?.name || /[\r\n<>]/.test(service.name) || service.name.length > 80) {
    throw new Error('COVERAGE_SOURCING_SERVICE_NOT_FOUND')
  }

  return {
    coverageRequestId: request.id,
    request: {
      requestId: request.id,
      serviceId: request.service_id,
      requestedAmount: String(request.requested_amount),
      remainingAmount: String(remaining),
      currency: request.currency,
      attributes,
      route,
      serviceName: service.name.trim(),
    },
  }
}

/**
 * An administrator can narrow sourcing to a single contact already in WACRM.
 * This is a FILTER on eligible supplier history, never a substitute for
 * supplier matching, consent/opt-out policy or outbound transport checks.
 */
export function parseCoverageSelectedContactId(
  targetPolicy: Readonly<Record<string, unknown>>,
): string | null {
  // Kept for backward-compatible one-recipient callers. A multi-target policy
  // MUST use parseExplicitCoverageContactIds instead of silently picking one.
  let ids: readonly string[] | null
  try {
    ids = parseExplicitCoverageContactIds(targetPolicy)
  } catch {
    throw new Error('COVERAGE_SOURCING_SELECTED_CONTACT_INVALID')
  }
  if (ids && ids.length !== 1) {
    throw new Error('COVERAGE_SOURCING_SELECTED_CONTACT_INVALID')
  }
  return ids?.[0] ?? null
}

export function buildCoverageSupplierCandidates(
  request: CoverageRequestRow,
  offerRows: readonly CoverageOfferHistoryRow[],
  allowedRegionIds: readonly string[] = [],
  selectedContactIds: string | readonly string[] | null = null,
): AgentTaskTargetCandidate[] {
  const normalizedRequest = normalizeCoverageAttributes(request.attributes)
  if (!normalizedRequest.ok) {
    throw new Error('COVERAGE_SOURCING_REQUEST_ATTRIBUTES_INVALID')
  }
  const requestAttributes = normalizedRequest.normalized
  const regionScope = new Set(allowedRegionIds)
  const selected = typeof selectedContactIds === 'string'
    ? [selectedContactIds]
    : selectedContactIds
  const selectedSet = selected ? new Set(selected) : null
  const candidates: AgentTaskTargetCandidate[] = []

  for (const row of offerRows) {
    if (selectedSet && !selectedSet.has(row.provider_contact_id)) continue
    if (row.provider_contact_id === request.requester_contact_id) continue
    if (!UUID_RE.test(row.provider_contact_id)) continue

    const normalizedOffer = normalizeCoverageAttributes(row.attributes)
    if (!normalizedOffer.ok) continue
    const offerAttributes = normalizedOffer.normalized
    if (!coverageOfferMatchesSourcingRequest(
      requestAttributes, offerAttributes,
    )) continue
    if (
      regionScope.size > 0 &&
      ![offerAttributes.pay_region_id, offerAttributes.receive_region_id].some(
        regionId => regionId !== null && regionScope.has(regionId),
      )
    ) continue

    // Respect an operator's exact selected order before the normal
    // deterministic supplier-history rank. The kernel still deduplicates
    // contact identities and SQL independently checks admission per contact.
    const selectedRank = selected && selected.length > 1
      ? String(selected.indexOf(row.provider_contact_id)).padStart(3, '0') + ':'
      : ''
    candidates.push({
      contactId: row.provider_contact_id,
      counterpartyRole: 'coverage_supplier',
      sortKey: selectedRank +
        supplierHistorySortKey(row) + ':' + row.provider_contact_id,
    })
  }
  if (selected && selected.length > 1) {
    candidates.sort((a,b) =>
      selected.indexOf(a.contactId) - selected.indexOf(b.contactId))
  }
  return candidates
}

export const COVERAGE_SUPPLIER_CANDIDATE_RESOLVER: AgentTaskTargetResolver = {
  key: 'coverage.supplier_candidates',
  version: 1,
  domain: 'coverage',

  async resolve(db, context): Promise<readonly AgentTaskTargetCandidate[]> {
    const coverageRequestId = parseCoverageSourcingRequestId(
      context.taskContext,
    )

    const { data: requestData, error: requestError } = await db
      .from('coverage_requests')
      .select(
        'id, service_id, requester_contact_id, requested_amount, reserved_amount, fulfilled_amount, currency, attributes, status',
      )
      .eq('account_id', context.accountId)
      .eq('id', coverageRequestId)
      .maybeSingle()

    if (requestError) throw requestError
    if (!requestData) throw new Error('COVERAGE_SOURCING_REQUEST_NOT_FOUND')

    const request = requestData as CoverageRequestRow
    if (!SOURCEABLE_REQUEST_STATUSES.has(request.status)) {
      return []
    }
    if (!(positiveRemaining(request) > 0)) return []

    const selectedContactIds = parseExplicitCoverageContactIds(context.targetPolicy)
    const coverageRegionIds = context.targetPolicy.coverageRegionIds
    const allowedRegionIds =
      coverageRegionIds === undefined
        ? []
        : Array.isArray(coverageRegionIds) &&
            coverageRegionIds.length <= 100 &&
            coverageRegionIds.every(
              (value) => typeof value === 'string' && UUID_RE.test(value),
            )
          ? [...new Set(coverageRegionIds as string[])]
          : (() => {
              throw new Error('COVERAGE_SOURCING_REGION_SCOPE_INVALID')
            })()


    if (selectedContactIds) {
      // An operator may explicitly target a known CRM contact even without
      // matching Coverage offer history. The recommendation is UI-only.
      // Only these exact account-owned contacts can become Task Targets.
      // Transport opt-out/consent, limits and session policy remain mandatory.
      const { data: scoped, error: selectedError } = await db.from('contacts')
        .select('id').eq('account_id', context.accountId)
        .in('id', selectedContactIds).limit(selectedContactIds.length)
      if (selectedError) throw selectedError
      const existing = new Set((scoped ?? []).map(row => row.id))
      if (selectedContactIds.some(id => !existing.has(id))) {
        throw new Error('COVERAGE_SOURCING_SELECTED_CONTACT_OUTSIDE_ACCOUNT')
      }
      return selectedContactIds
        .filter(id => id !== request.requester_contact_id)
        .map((contactId, index) => ({
          contactId,
          counterpartyRole: 'coverage_supplier',
          sortKey: String(index).padStart(3, '0') + ':operator_selected:' + contactId,
        }))
    }

    // Automatic sourcing still requires matching historic supplier offers.
    const queryLimit = Math.max(20, Math.min(context.maxCandidates * 10, 1000))
    const { data: rows, error: offersError } = await db.from('coverage_offers')
      .select('provider_contact_id,attributes,status,created_at')
      .eq('account_id', context.accountId)
      .eq('service_id', request.service_id)
      .eq('currency', request.currency)
      .in('status', [...SUPPLIER_HISTORY_STATUSES])
      .neq('provider_contact_id', request.requester_contact_id)
      .order('created_at', { ascending: false }).limit(queryLimit)
    if (offersError) throw offersError
    const offerRows = (rows ?? []) as CoverageOfferHistoryRow[]

    return buildCoverageSupplierCandidates(
      request,
      offerRows,
      allowedRegionIds,
      null,
    )
  },
}

function policyString(
  context: AgentTaskOutboundPolicyContext,
  key: string,
  fallback: string,
): string {
  const value = context.policy.config[key]
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : fallback
}

function contextString(
  context: AgentTaskOutboundPolicyContext,
  key: string,
): string {
  const request = context.taskContext.request
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('COVERAGE_SOURCING_REQUEST_SNAPSHOT_REQUIRED')
  }
  const value = (request as Record<string, unknown>)[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('COVERAGE_SOURCING_REQUEST_SNAPSHOT_INVALID')
  }
  return value.trim()
}

export const COVERAGE_SOURCING_MESSAGE_POLICY: AgentTaskOutboundMessagePolicy = {
  key: 'coverage.sourcing_message',
  version: 1,
  domain: 'coverage',

  async prepare(
    context,
  ): Promise<AgentTaskOutboundMessageCandidate> {
    if (
      context.taskType !== COVERAGE_SOURCING_TASK_TYPE.key ||
      context.counterpartyRole !== 'coverage_supplier'
    ) {
      throw new Error('COVERAGE_SOURCING_MESSAGE_CONTEXT_INVALID')
    }

    const templateName = policyString(
      context,
      'templateName',
      'coverage_sourcing_supplier_v1',
    )
    const language = policyString(context, 'templateLanguage', 'ar')

    // Never expose requester identity or provider internals in template params.
    // The frozen request snapshot contains only business facts needed to ask a
    // supplier about capacity.
    const remainingAmount = contextString(
      context,
      'remainingAmount',
    )
    const currency = contextString(context, 'currency')

    return {
      kind: 'template',
      templateName,
      language,
      params: [remainingAmount, currency],
    }
  },
}


/**
 * SOF-60: OpenWA has no Meta approved-template transport.
 * We never fabricate Meta approval or allow free-form LLM outreach here.
 * SQL requires either a fresh inbound on the exact bound session OR an
 * explicitly attested, scoped, expiring OpenWA phone-call WhatsApp opt-in on
 * pinned TEST. Meta template/session rules, opt-out and all budgets remain.
 */
export const COVERAGE_SOURCING_MESSAGE_POLICY_V2: AgentTaskOutboundMessagePolicy = {
  key: 'coverage.sourcing_message',
  version: 2,
  domain: 'coverage',
  generation: 'deterministic',
  async prepare(context): Promise<AgentTaskOutboundMessageCandidate> {
    if (context.taskType !== COVERAGE_SOURCING_TASK_TYPE.key ||
        context.taskTypeVersion !== 2 ||
        context.counterpartyRole !== 'coverage_supplier') {
      throw new Error('COVERAGE_SOURCING_MESSAGE_CONTEXT_INVALID')
    }
    // Missing provider is a denied route, not permission to send a template
    // through an unrelated Meta connection.
    if (context.whatsappProvider !== 'meta_cloud' &&
        context.whatsappProvider !== 'openwa') {
      throw new Error('COVERAGE_SOURCING_PROVIDER_UNRESOLVED')
    }
    const remainingAmount = contextString(context, 'remainingAmount')
    const requestedAmount = contextString(context, 'requestedAmount')
    const currency = contextString(context, 'currency')
    const snapshot = context.taskContext.request as Record<string, unknown> | null
    const rawAttributes = snapshot?.attributes
    if (!rawAttributes || typeof rawAttributes !== 'object' || Array.isArray(rawAttributes)) {
      throw new Error('COVERAGE_SOURCING_ROUTE_SNAPSHOT_MISSING')
    }
    // New Tasks freeze all named route facts on creation. Historical v2 Task
    // snapshots lack labels: resolve only from the exact account-owned region
    // IDs; never send amount-only or infer a name from free-text supplier data.
    const route = validSupplierCoverageRoute(snapshot.route)
      ? snapshot.route
      : await loadSupplierCoverageRoute(
        supabaseAdmin(), context.accountId, rawAttributes as Record<string, unknown>,
      )
    assertSupplierRouteMatchesAttributes(route, rawAttributes as Record<string, unknown>)
    const name = typeof snapshot.serviceName === 'string' &&
      /^[^\r\n<>]{2,80}$/.test(snapshot.serviceName)
      ? snapshot.serviceName : 'التغطية'
    // The same frozen business facts are used for either provider; validate
    // their shapes so snapshots cannot inject instructions into the text.
    if (!/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,4})?$/.test(remainingAmount) ||
        !/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,4})?$/.test(requestedAmount) ||
        !/^[A-Z]{3}$/.test(currency)) {
      throw new Error('COVERAGE_SOURCING_MESSAGE_FACTS_INVALID')
    }
    if (context.whatsappProvider === 'meta_cloud') {
      // Never downgrade this v2 business request to a 2-parameter template.
      // A non-approved v2 template must block sending until Meta approval.
      const template = policyString(context,'templateName','coverage_sourcing_supplier_v2')
      if (template !== 'coverage_sourcing_supplier_v2' &&
          template !== 'coverage_sourcing_supplier_v1') {
        throw new Error('COVERAGE_SOURCING_TEMPLATE_V2_REQUIRED')
      }
      return {
        kind:'template',
        templateName:'coverage_sourcing_supplier_v2',
        language: policyString(context,'templateLanguage','ar'),
        params:[
          remainingAmount,currency,
          route.requesterReceiveRegion,route.requesterReceiveMethod,
          route.requesterPayRegion,route.requesterPayMethod,
        ],
      }
    }
    return {
      kind:'text',
      text: [
        `مرحبًا، لدينا طلب ${name} بقيمة ${remainingAmount} ${currency}${
          requestedAmount !== remainingAmount
            ? ` (من إجمالي ${requestedAmount} ${currency})` : ''
        }.`,
        `العميل يدفع في ${route.requesterPayRegion} (${route.requesterPayMethod})، ويستلم في ${route.requesterReceiveRegion} (${route.requesterReceiveMethod}).`,
        `أنت تسلّم التغطية في ${route.requesterReceiveRegion} وتستلم مقابلها في ${route.requesterPayRegion}.`,
        'إذا تستطيع توفيرها، اذكر في رد واحد: المبلغ المتاح، عمولتك لكل 1000، وأي اختلاف في المكان أو الشروط. سنعرض ما تقوله على الإدارة.',
        'لإيقاف الرسائل، اكتب «إيقاف».',
      ].join('\n'),
    }
  },
}


export const COVERAGE_SOURCING_COMPLETION_POLICY: AgentTaskCompletionPolicy = {
  key: 'coverage.sourcing_completion',
  version: 1,
  domain: 'coverage',

  async evaluate(db, context) {
    const coverageRequestId = parseCoverageSourcingRequestId(
      context.taskContext,
    )

    const { data: request, error: requestError } = await db
      .from('coverage_requests')
      .select(
        'id, requested_amount, reserved_amount, fulfilled_amount, status',
      )
      .eq('account_id', context.accountId)
      .eq('id', coverageRequestId)
      .maybeSingle()
    if (requestError) throw requestError

    if (!request) {
      return {
        status: 'failed',
        reason: 'coverage_request_not_found',
        payload: { coverageRequestId },
      }
    }

    const requestRow = request as {
      requested_amount: string | number
      reserved_amount: string | number
      fulfilled_amount: string | number
      status: string
    }
    const remaining = Math.max(
      Number(requestRow.requested_amount) -
        Number(requestRow.reserved_amount ?? 0) -
        Number(requestRow.fulfilled_amount ?? 0),
      0,
    )

    if (
      remaining <= 0 ||
      requestRow.status === 'fully_reserved' ||
      requestRow.status === 'fulfilled'
    ) {
      return {
        status: 'completed',
        reason: 'coverage_request_satisfied',
        payload: {
          coverageRequestId,
          remainingAmount: String(remaining),
          requestStatus: requestRow.status,
        },
      }
    }

    if (
      requestRow.status === 'cancelled' ||
      requestRow.status === 'expired'
    ) {
      return {
        status: 'cancelled',
        reason: 'coverage_request_terminal',
        payload: {
          coverageRequestId,
          requestStatus: requestRow.status,
        },
      }
    }

    const { data: targets, error: targetError } = await db
      .from('ai_agent_task_targets')
      .select('status')
      .eq('account_id', context.accountId)
      .eq('task_id', context.taskId)
    if (targetError) throw targetError

    const statuses = (targets ?? []).map(
      (target) => (target as { status: string }).status,
    )
    const actionable = new Set([
      'candidate',
      'eligible',
      'queued',
      'preparing',
      'sending',
      'contacted',
      'awaiting_reply',
      'replied',
      'in_progress',
    ])
    const actionableCount = statuses.filter((status) =>
      actionable.has(status),
    ).length

    if (actionableCount > 0) {
      return {
        status: 'continue',
        reason: 'coverage_targets_still_actionable',
        payload: {
          coverageRequestId,
          remainingAmount: String(remaining),
          actionableTargets: actionableCount,
        },
      }
    }

    const completedTargets = statuses.filter(
      (status) => status === 'completed',
    ).length
    const humanTargets = statuses.filter(
      (status) => status === 'paused_for_human',
    ).length

    // Sourcing a genuine, admin-approved offer completes the SUPPLIER SEARCH,
    // even if the buyer's source request has not yet been reserved/fulfilled.
    // Do not label the financial coverage Request itself fulfilled: that is a
    // separate settlement / reservation lifecycle controlled by WACRM.
    if (completedTargets > 0) {
      return {
        status: 'completed',
        reason: 'supplier_offer_executed',
        payload: {
          coverageRequestId,
          remainingAmount: String(remaining),
          requestStatus: requestRow.status,
          completedSuppliers: completedTargets,
          totalSuppliers: statuses.length,
        },
      }
    }

    return {
      status: 'partially_completed',
      reason:
        statuses.length === 0
          ? 'no_supplier_candidates'
          : 'supplier_targets_exhausted',
      payload: {
        coverageRequestId,
        remainingAmount: String(remaining),
        targetCount: statuses.length,
        completedTargets,
        humanTargets,
      },
    }
  },
}

export const COVERAGE_SOURCING_TASK_MODULE: AgentTaskModule = {
  domain: 'coverage',
  taskTypes: [COVERAGE_SOURCING_TASK_TYPE, COVERAGE_SOURCING_TASK_TYPE_V2],
  targetResolvers: [COVERAGE_SUPPLIER_CANDIDATE_RESOLVER],
  outboundMessagePolicies: [COVERAGE_SOURCING_MESSAGE_POLICY, COVERAGE_SOURCING_MESSAGE_POLICY_V2],
  completionPolicies: [COVERAGE_SOURCING_COMPLETION_POLICY],
}
