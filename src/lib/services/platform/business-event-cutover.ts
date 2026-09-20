import { supabaseAdmin } from '@/lib/ai/admin-client'

export type ShadowProjectionStatus =
  | 'pending'
  | 'checking'
  | 'matched_legacy'
  | 'mismatched_legacy'
  | 'native_only'
  | 'not_deliverable'
  | 'unsupported_projector'
  | 'comparison_missing'
  | 'failed'

export interface CustomerWhatsAppShadowEvidence {
  event_type: string
  event_version: number
  shadow_projection_status: ShadowProjectionStatus
  legacy_notification_id: string | null
}

export interface BusinessEventCutoverReadiness {
  ready: boolean
  eligibleEvents: number
  activeRows: number
  matchedLegacy: number
  blockers: number
  statusCounts: Record<ShadowProjectionStatus, number>
  reasons: readonly string[]
}

const ALL_STATUSES: readonly ShadowProjectionStatus[] = [
  'pending',
  'checking',
  'matched_legacy',
  'mismatched_legacy',
  'native_only',
  'not_deliverable',
  'unsupported_projector',
  'comparison_missing',
  'failed',
]

export function evaluateBusinessEventCutoverReadiness(input: {
  evidence: readonly CustomerWhatsAppShadowEvidence[]
  activeRows: number
}): BusinessEventCutoverReadiness {
  const statusCounts = Object.fromEntries(
    ALL_STATUSES.map((status) => [status, 0]),
  ) as Record<ShadowProjectionStatus, number>

  for (const row of input.evidence) {
    statusCounts[row.shadow_projection_status] += 1
  }

  const reasons: string[] = []
  if (input.activeRows > 0) {
    reasons.push('ACTIVE_BUSINESS_EVENT_ROWS_ALREADY_PRESENT')
  }
  if (input.evidence.length === 0) {
    reasons.push('NO_CUSTOMER_WHATSAPP_SHADOW_EVIDENCE')
  }

  const matchedLegacy = statusCounts.matched_legacy
  const blockers = input.evidence.length - matchedLegacy
  if (blockers > 0) {
    reasons.push('UNVERIFIED_CUSTOMER_WHATSAPP_EVENTS')
  }

  return {
    ready: reasons.length === 0,
    eligibleEvents: input.evidence.length,
    activeRows: input.activeRows,
    matchedLegacy,
    blockers,
    statusCounts,
    reasons,
  }
}

/**
 * Read-only cutover gate. This function never changes delivery_mode and cannot
 * activate the new outbox. A later explicit cutover step must still perform a
 * separate guarded migration or administrative action.
 */
export async function inspectBusinessEventCutoverReadiness(input: {
  accountId: string
}): Promise<BusinessEventCutoverReadiness> {
  const db = supabaseAdmin()

  const [{ data: evidence, error: evidenceError }, { count: activeRows, error: activeError }] =
    await Promise.all([
      db
        .from('business_event_outbox')
        .select(
          'event_type, event_version, shadow_projection_status, legacy_notification_id',
        )
        .eq('account_id', input.accountId)
        .eq('delivery_mode', 'shadow')
        .eq('audience', 'customer')
        .eq('channel', 'whatsapp'),
      db
        .from('business_event_outbox')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', input.accountId)
        .eq('delivery_mode', 'active'),
    ])

  if (evidenceError) throw evidenceError
  if (activeError) throw activeError

  return evaluateBusinessEventCutoverReadiness({
    evidence: (evidence ?? []) as CustomerWhatsAppShadowEvidence[],
    activeRows: activeRows ?? 0,
  })
}


export async function requeueShadowBusinessEventProjection(input: {
  accountId: string
  eventTypes?: readonly string[]
  statuses?: readonly Exclude<
    ShadowProjectionStatus,
    'pending' | 'checking' | 'matched_legacy'
  >[]
}): Promise<number> {
  const db = supabaseAdmin()
  const { data, error } = await db.rpc(
    'requeue_business_event_shadow_projection',
    {
      p_account_id: input.accountId,
      p_event_types:
        input.eventTypes && input.eventTypes.length > 0
          ? [...input.eventTypes]
          : null,
      p_statuses:
        input.statuses && input.statuses.length > 0
          ? [...input.statuses]
          : undefined,
    },
  )
  if (error) throw error
  return typeof data === 'number' ? data : Number(data ?? 0)
}
