import { supabaseAdmin } from '@/lib/ai/admin-client'
import { renderFxTradeBusinessEventText } from '@/lib/messaging/fx-v2-outbox'
import { createSupabaseTemplateOverrideStore } from '@/lib/messaging/supabase-store'
import type { MessageAudience, MessageChannel } from '@/lib/messaging/types'
import { renderBusinessEventProjection } from './business-event-message-renderer'
import { CURRENT_EVENT_PROJECTOR_REGISTRY } from './composition'

export interface ShadowBusinessEventRow {
  id: string
  event_type: string
  event_version: number
  subject_type: string
  subject_id: string
  audience: string | null
  channel: string | null
  contact_id: string | null
  conversation_id: string | null
  correlation_id: string | null
  causation_id: string | null
  payload: Record<string, unknown>
  legacy_notification_id: string | null
  dedupe_key: string
  created_at: string
  shadow_checked_at: string
}

/**
 * Claims shadow rows for parity inspection only.
 *
 * This helper never sends WhatsApp and never promotes delivery_mode. The SQL
 * RPC only stamps shadow_checked_at so concurrent inspectors cannot compare the
 * same event twice.
 */
export async function claimShadowBusinessEvents(input: {
  accountId: string
  limit?: number
}): Promise<readonly ShadowBusinessEventRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
  const { data, error } = await supabaseAdmin().rpc(
    'claim_business_event_outbox_shadow',
    {
      p_account_id: input.accountId,
      p_limit: limit,
    },
  )
  if (error) throw error
  return (data ?? []) as ShadowBusinessEventRow[]
}

export interface ShadowBusinessEventParity {
  claimed: number
  linkedToLegacy: number
  nativeOnly: number
  customerEventsWithoutLegacyLink: number
}

/**
 * Summarizes strangler parity without changing the active notification worker.
 *
 * Native-only lifecycle events (for example coverage.match.reserved) are
 * expected. Customer/WhatsApp rows without a legacy link are highlighted for
 * review because those are the events where an accidental cutover could create
 * a behavioral gap.
 */
export async function inspectShadowBusinessEventParity(input: {
  accountId: string
  limit?: number
}): Promise<ShadowBusinessEventParity> {
  const rows = await claimShadowBusinessEvents(input)
  let linkedToLegacy = 0
  let nativeOnly = 0
  let customerEventsWithoutLegacyLink = 0

  for (const row of rows) {
    if (row.legacy_notification_id) linkedToLegacy += 1
    else {
      nativeOnly += 1
      if (row.audience === 'customer' && row.channel === 'whatsapp') {
        customerEventsWithoutLegacyLink += 1
      }
    }
  }

  return {
    claimed: rows.length,
    linkedToLegacy,
    nativeOnly,
    customerEventsWithoutLegacyLink,
  }
}


export interface ShadowBusinessEventRenderingParity {
  claimed: number
  projected: number
  matchedLegacy: number
  mismatchedLegacy: number
  nativeOnly: number
  unsupportedProjector: number
  unsupportedSurface: number
  comparisonMissing: number
  failed: number
}

/**
 * Renders claimed shadow events through the new Event Projector platform and,
 * when a strangler link exists, compares the text with the still-active legacy
 * path. This function NEVER sends a message and never calls a transport.
 */
export async function inspectShadowBusinessEventRendering(input: {
  accountId: string
  limit?: number
}): Promise<ShadowBusinessEventRenderingParity> {
  const rows = await claimShadowBusinessEvents(input)
  const db = supabaseAdmin()
  const store = createSupabaseTemplateOverrideStore(db)

  const result: ShadowBusinessEventRenderingParity = {
    claimed: rows.length,
    projected: 0,
    matchedLegacy: 0,
    mismatchedLegacy: 0,
    nativeOnly: 0,
    unsupportedProjector: 0,
    unsupportedSurface: 0,
    comparisonMissing: 0,
    failed: 0,
  }

  for (const row of rows) {
    const audience = asMessageAudience(row.audience)
    const channel = asMessageChannel(row.channel)
    if (!audience || !channel) {
      result.unsupportedSurface += 1
      continue
    }

    if (!CURRENT_EVENT_PROJECTOR_REGISTRY.has(row.event_type, row.event_version)) {
      result.unsupportedProjector += 1
      continue
    }

    try {
      const projection = await CURRENT_EVENT_PROJECTOR_REGISTRY.project({
        accountId: input.accountId,
        eventType: row.event_type,
        eventVersion: row.event_version,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        audience,
        channel,
        correlationId: row.correlation_id,
        causationId: row.causation_id,
        payload: row.payload,
      })
      const rendered = await renderBusinessEventProjection({
        accountId: input.accountId,
        projection,
        store,
      })
      result.projected += 1

      if (!row.legacy_notification_id) {
        result.nativeOnly += 1
        continue
      }

      const { data: legacy, error: legacyError } = await db
        .from('customer_intent_notifications')
        .select('message_text, fx_trade_request_id, event_type')
        .eq('account_id', input.accountId)
        .eq('id', row.legacy_notification_id)
        .maybeSingle()
      if (legacyError) throw legacyError
      if (!legacy) {
        result.comparisonMissing += 1
        continue
      }

      const legacyText = legacy.fx_trade_request_id
        ? await renderFxTradeBusinessEventText({
            accountId: input.accountId,
            tradeRequestId: legacy.fx_trade_request_id,
            eventType: legacy.event_type,
          })
        : legacy.message_text

      if (rendered.text === legacyText) result.matchedLegacy += 1
      else result.mismatchedLegacy += 1
    } catch (error) {
      result.failed += 1
      console.error(
        `[business event shadow] projection failed event=${row.event_type}@${row.event_version} id=${row.id.slice(0, 8)}:`,
        error,
      )
    }
  }

  return result
}

function asMessageAudience(value: string | null): MessageAudience | null {
  return value === 'customer' || value === 'admin' || value === 'internal'
    ? value
    : null
}

function asMessageChannel(value: string | null): MessageChannel | null {
  return value === 'whatsapp' ||
    value === 'in_app' ||
    value === 'email' ||
    value === 'sms'
    ? value
    : null
}
