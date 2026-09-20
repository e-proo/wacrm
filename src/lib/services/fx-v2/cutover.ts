import { supabaseAdmin } from '@/lib/ai/admin-client'
import {
  inspectShadowBusinessEventRendering,
  type ShadowBusinessEventRenderingParity,
} from '@/lib/services/platform/business-event-outbox'
import { requeueShadowBusinessEventProjection } from '@/lib/services/platform/business-event-cutover'

export const FX_BUSINESS_EVENT_ROUTE_KEY = 'fx_trade_customer_whatsapp' as const

export const FX_BUSINESS_EVENT_TYPES = [
  'exchange_rate.trade.requested',
  'exchange_rate.trade.approved',
  'exchange_rate.trade.rejected',
  'exchange_rate.trade.completed',
] as const

export type FxBusinessEventDeliveryMode = 'legacy' | 'active'

export interface FxBusinessEventCutoverReadiness {
  routeKey: typeof FX_BUSINESS_EVENT_ROUTE_KEY
  mode: FxBusinessEventDeliveryMode
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

export interface FxBusinessEventShadowPreparationResult {
  backfilledRows: number
  supersededLegacyRows: number
  requeuedRows: number
  rendering: ShadowBusinessEventRenderingParity
  readiness: FxBusinessEventCutoverReadiness
}

export interface FxBusinessEventModeChange {
  routeKey: typeof FX_BUSINESS_EVENT_ROUTE_KEY
  mode: FxBusinessEventDeliveryMode
  changed: boolean
  demotedUnsent?: number
  syncedLegacySent?: number
}

export async function inspectFxBusinessEventCutoverReadiness(input: {
  accountId: string
}): Promise<FxBusinessEventCutoverReadiness> {
  const { data, error } = await supabaseAdmin().rpc(
    'inspect_fx_business_event_cutover_readiness',
    {
      p_account_id: input.accountId,
    },
  )
  if (error) throw error
  return parseReadiness(data)
}

/**
 * Explicit server-side cutover switch. No caller should invoke this implicitly
 * from request handling; activation is an operations action after shadow
 * evidence has been reviewed.
 */
export async function setFxBusinessEventDeliveryMode(input: {
  accountId: string
  mode: FxBusinessEventDeliveryMode
}): Promise<FxBusinessEventModeChange> {
  const { data, error } = await supabaseAdmin().rpc(
    'set_fx_business_event_delivery_mode',
    {
      p_account_id: input.accountId,
      p_mode: input.mode,
    },
  )
  if (error) throw error
  return parseModeChange(data)
}

function parseReadiness(value: unknown): FxBusinessEventCutoverReadiness {
  const row = asRecord(value)
  const mode = modeValue(row.mode)
  return {
    routeKey: FX_BUSINESS_EVENT_ROUTE_KEY,
    mode,
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

function parseModeChange(value: unknown): FxBusinessEventModeChange {
  const row = asRecord(value)
  return {
    routeKey: FX_BUSINESS_EVENT_ROUTE_KEY,
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
    throw new Error('FX_BUSINESS_EVENT_CUTOVER_RESPONSE_INVALID')
  }
  return value as Record<string, unknown>
}

function modeValue(value: unknown): FxBusinessEventDeliveryMode {
  if (value === 'legacy' || value === 'active') return value
  throw new Error('FX_BUSINESS_EVENT_CUTOVER_MODE_INVALID')
}

function integerValue(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('FX_BUSINESS_EVENT_CUTOVER_COUNT_INVALID')
  }
  return n
}


export async function backfillFxBusinessEventShadowHistory(input: {
  accountId: string
}): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc(
    'backfill_fx_business_event_shadow_history',
    {
      p_account_id: input.accountId,
    },
  )
  if (error) throw error
  return integerValue(asRecord(data).affected_rows)
}

export async function reconcileSupersededFxLegacyNotifications(input: {
  accountId: string
}): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc(
    'reconcile_superseded_fx_customer_notifications',
    {
      p_account_id: input.accountId,
    },
  )
  if (error) throw error
  return integerValue(asRecord(data).superseded_rows)
}

/**
 * Prepares real account-scoped FX evidence without activating delivery.
 *
 * Historical legacy rows are mirrored into shadow, obsolete pending lifecycle
 * notifications are terminally reconciled, prior failed shadow checks are
 * requeued, and ONLY canonical FX event types are rendered for parity.
 */
export async function prepareFxBusinessEventShadowVerification(input: {
  accountId: string
  limit?: number
}): Promise<FxBusinessEventShadowPreparationResult> {
  const backfilledRows = await backfillFxBusinessEventShadowHistory(input)
  const supersededLegacyRows =
    await reconcileSupersededFxLegacyNotifications(input)
  const requeuedRows = await requeueShadowBusinessEventProjection({
    accountId: input.accountId,
    eventTypes: FX_BUSINESS_EVENT_TYPES,
    statuses: [
      'mismatched_legacy',
      'unsupported_projector',
      'comparison_missing',
      'failed',
    ],
  })
  const rendering = await inspectShadowBusinessEventRendering({
    accountId: input.accountId,
    eventTypes: FX_BUSINESS_EVENT_TYPES,
    limit: input.limit,
  })
  const readiness = await inspectFxBusinessEventCutoverReadiness(input)

  return {
    backfilledRows,
    supersededLegacyRows,
    requeuedRows,
    rendering,
    readiness,
  }
}


function stringArrayValue(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const items = value.filter((item): item is string => typeof item === 'string')
  if (items.length !== value.length) {
    throw new Error('FX_BUSINESS_EVENT_CUTOVER_EVENT_TYPES_INVALID')
  }
  return items
}
