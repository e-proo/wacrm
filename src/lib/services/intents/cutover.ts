import { supabaseAdmin } from '@/lib/ai/admin-client'
import {
  inspectShadowBusinessEventRendering,
  type ShadowBusinessEventRenderingParity,
} from '@/lib/services/platform/business-event-outbox'
import {
  requeueShadowBusinessEventProjection,
  requeueStaleShadowBusinessEventProjection,
} from '@/lib/services/platform/business-event-cutover'

export const INTENTS_BUSINESS_EVENT_ROUTE_KEY =
  'service_request_customer_whatsapp' as const

export const INTENTS_CUSTOMER_BUSINESS_EVENT_TYPES = [
  'service_request.approved',
  'service_request.rejected',
  'service_request.matched',
  'service_request.needs_clarification',
] as const

export type IntentsBusinessEventDeliveryMode = 'legacy' | 'active'

export interface IntentsBusinessEventCutoverReadiness {
  routeKey: typeof INTENTS_BUSINESS_EVENT_ROUTE_KEY
  mode: IntentsBusinessEventDeliveryMode
  ready: boolean
  requiredEventTypes: number
  matchedEventTypes: number
  matchedEventTypeKeys: readonly string[]
  missingEventTypes: readonly string[]
  pendingEventTypes: readonly string[]
  evidenceRows: number
  blockers: number
  legacyNonterminal: number
  activeNonterminal: number
}

export interface IntentsBusinessEventModeChange {
  routeKey: typeof INTENTS_BUSINESS_EVENT_ROUTE_KEY
  mode: IntentsBusinessEventDeliveryMode
  changed: boolean
  demotedUnsent?: number
  syncedLegacySent?: number
}

export interface IntentsBusinessEventShadowPreparationResult {
  recoveredStaleRows: number
  requeuedRows: number
  rendering: ShadowBusinessEventRenderingParity
  readiness: IntentsBusinessEventCutoverReadiness
}

export async function inspectIntentsBusinessEventCutoverReadiness(input: {
  accountId: string
}): Promise<IntentsBusinessEventCutoverReadiness> {
  const { data, error } = await supabaseAdmin().rpc(
    'inspect_intents_business_event_cutover_readiness',
    { p_account_id: input.accountId },
  )
  if (error) throw error
  return parseReadiness(data)
}

export async function setIntentsBusinessEventDeliveryMode(input: {
  accountId: string
  mode: IntentsBusinessEventDeliveryMode
}): Promise<IntentsBusinessEventModeChange> {
  const { data, error } = await supabaseAdmin().rpc(
    'set_intents_business_event_delivery_mode',
    {
      p_account_id: input.accountId,
      p_mode: input.mode,
    },
  )
  if (error) throw error
  return parseModeChange(data)
}

/**
 * Builds real parity evidence from native Intents events. This deliberately
 * does not manufacture missing lifecycle outcomes: each required event type
 * must be observed from an actual change-request-backed customer intent.
 */
export async function prepareIntentsBusinessEventShadowVerification(input: {
  accountId: string
  limit?: number
}): Promise<IntentsBusinessEventShadowPreparationResult> {
  const recoveredStaleRows =
    await requeueStaleShadowBusinessEventProjection({
      accountId: input.accountId,
      eventTypes: INTENTS_CUSTOMER_BUSINESS_EVENT_TYPES,
      staleAfterSeconds: 30,
    })

  const requeuedRows = await requeueShadowBusinessEventProjection({
    accountId: input.accountId,
    eventTypes: INTENTS_CUSTOMER_BUSINESS_EVENT_TYPES,
    statuses: [
      'mismatched_legacy',
      'unsupported_projector',
      'comparison_missing',
      'failed',
    ],
  })

  const rendering = await inspectShadowBusinessEventRendering({
    accountId: input.accountId,
    eventTypes: INTENTS_CUSTOMER_BUSINESS_EVENT_TYPES,
    limit: input.limit,
  })

  const readiness = await inspectIntentsBusinessEventCutoverReadiness(input)

  return {
    recoveredStaleRows,
    requeuedRows,
    rendering,
    readiness,
  }
}

function parseReadiness(value: unknown): IntentsBusinessEventCutoverReadiness {
  const row = asRecord(value)
  return {
    routeKey: INTENTS_BUSINESS_EVENT_ROUTE_KEY,
    mode: modeValue(row.mode),
    ready: row.ready === true,
    requiredEventTypes: integerValue(row.required_event_types),
    matchedEventTypes: integerValue(row.matched_event_types),
    matchedEventTypeKeys: stringArrayValue(row.matched_event_type_keys),
    missingEventTypes: stringArrayValue(row.missing_event_types),
    pendingEventTypes: stringArrayValue(row.pending_event_types),
    evidenceRows: integerValue(row.evidence_rows),
    blockers: integerValue(row.blockers),
    legacyNonterminal: integerValue(row.legacy_nonterminal),
    activeNonterminal: integerValue(row.active_nonterminal),
  }
}

function parseModeChange(value: unknown): IntentsBusinessEventModeChange {
  const row = asRecord(value)
  return {
    routeKey: INTENTS_BUSINESS_EVENT_ROUTE_KEY,
    mode: modeValue(row.mode),
    changed: row.changed === true,
    ...(row.demoted_unsent == null
      ? {}
      : { demotedUnsent: integerValue(row.demoted_unsent) }),
    ...(row.synced_legacy_sent == null
      ? {}
      : { syncedLegacySent: integerValue(row.synced_legacy_sent) }),
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INTENTS_BUSINESS_EVENT_CUTOVER_RESPONSE_INVALID')
  }
  return value as Record<string, unknown>
}

function modeValue(value: unknown): IntentsBusinessEventDeliveryMode {
  if (value === 'legacy' || value === 'active') return value
  throw new Error('INTENTS_BUSINESS_EVENT_CUTOVER_MODE_INVALID')
}

function integerValue(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('INTENTS_BUSINESS_EVENT_CUTOVER_COUNT_INVALID')
  }
  return n
}

function stringArrayValue(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const items = value.filter((item): item is string => typeof item === 'string')
  if (items.length !== value.length) {
    throw new Error('INTENTS_BUSINESS_EVENT_CUTOVER_EVENT_TYPES_INVALID')
  }
  return items
}
