import type { SupabaseClient } from '@supabase/supabase-js'
import { defineAgentTaskType } from '@/lib/ai/tasks/contracts'
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
  readCoverageAttributes,
  type CoverageAttributes,
  type CoverageMethod,
} from './attributes'

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

  return {
    coverageRequestId: request.id,
    request: {
      requestId: request.id,
      serviceId: request.service_id,
      requestedAmount: String(request.requested_amount),
      remainingAmount: String(remaining),
      currency: request.currency,
      attributes: (() => {
        const normalized = normalizeCoverageAttributes(request.attributes)
        if (!normalized.ok) {
          throw new Error('COVERAGE_SOURCING_REQUEST_ATTRIBUTES_INVALID')
        }
        return normalized.normalized
      })(),
    },
  }
}

export function buildCoverageSupplierCandidates(
  request: CoverageRequestRow,
  offerRows: readonly CoverageOfferHistoryRow[],
): AgentTaskTargetCandidate[] {
  const normalizedRequest = normalizeCoverageAttributes(request.attributes)
  if (!normalizedRequest.ok) {
    throw new Error('COVERAGE_SOURCING_REQUEST_ATTRIBUTES_INVALID')
  }
  const requestAttributes = normalizedRequest.normalized
  const candidates: AgentTaskTargetCandidate[] = []

  for (const row of offerRows) {
    if (row.provider_contact_id === request.requester_contact_id) continue
    if (!UUID_RE.test(row.provider_contact_id)) continue

    const normalizedOffer = normalizeCoverageAttributes(row.attributes)
    if (!normalizedOffer.ok) continue
    if (
      !coverageOfferMatchesSourcingRequest(
        requestAttributes,
        normalizedOffer.normalized,
      )
    ) {
      continue
    }

    candidates.push({
      contactId: row.provider_contact_id,
      counterpartyRole: 'coverage_supplier',
      sortKey:
        supplierHistorySortKey(row) + ':' + row.provider_contact_id,
    })
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

    const queryLimit = Math.max(
      20,
      Math.min(context.maxCandidates * 10, 1000),
    )

    const { data: offerRows, error: offersError } = await db
      .from('coverage_offers')
      .select('provider_contact_id, attributes, status, created_at')
      .eq('account_id', context.accountId)
      .eq('service_id', request.service_id)
      .eq('currency', request.currency)
      .in('status', [...SUPPLIER_HISTORY_STATUSES])
      .neq('provider_contact_id', request.requester_contact_id)
      .order('created_at', { ascending: false })
      .limit(queryLimit)

    if (offersError) throw offersError

    return buildCoverageSupplierCandidates(
      request,
      (offerRows ?? []) as CoverageOfferHistoryRow[],
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

export const COVERAGE_SOURCING_TASK_MODULE: AgentTaskModule = {
  domain: 'coverage',
  taskTypes: [COVERAGE_SOURCING_TASK_TYPE],
  targetResolvers: [COVERAGE_SUPPLIER_CANDIDATE_RESOLVER],
  outboundMessagePolicies: [COVERAGE_SOURCING_MESSAGE_POLICY],
}
