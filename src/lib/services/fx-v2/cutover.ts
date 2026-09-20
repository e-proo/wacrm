import { supabaseAdmin } from '@/lib/ai/admin-client'

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
  evidenceRows: number
  blockers: number
  legacyNonterminal: number
  activeNonterminal: number
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
