import { createHash } from 'node:crypto'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { renderFxTradeBusinessEventText } from '@/lib/messaging/fx-v2-outbox'
import { createSupabaseTemplateOverrideStore } from '@/lib/messaging/supabase-store'
import type { MessageAudience, MessageChannel } from '@/lib/messaging/types'
import { renderBusinessEventProjection } from './business-event-message-renderer'
import { CURRENT_EVENT_PROJECTOR_REGISTRY } from './composition'
import type { ShadowProjectionStatus } from './business-event-cutover'

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
 * Claims shadow rows for rendering/parity verification only.
 *
 * The SQL RPC moves rows into a durable "checking" state. It never promotes
 * delivery_mode and never sends a message.
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
  inspected: number
  linkedToLegacy: number
  nativeOnly: number
  customerEventsWithoutLegacyLink: number
}

/**
 * Read-only structural parity summary.
 *
 * Rendering parity is handled separately by inspectShadowBusinessEventRendering
 * and persisted as cutover evidence. This function deliberately does not claim
 * rows, so a dashboard/readiness check cannot consume pending verification work.
 */
export async function inspectShadowBusinessEventParity(input: {
  accountId: string
  limit?: number
}): Promise<ShadowBusinessEventParity> {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000)
  const { data, error } = await supabaseAdmin()
    .from('business_event_outbox')
    .select('legacy_notification_id, audience, channel')
    .eq('account_id', input.accountId)
    .eq('delivery_mode', 'shadow')
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) throw error

  const rows = data ?? []
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
    inspected: rows.length,
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
  notDeliverable: number
  unsupportedProjector: number
  comparisonMissing: number
  failed: number
}

/**
 * Renders claimed shadow events through the new Event Projector platform and,
 * when a strangler link exists, compares the text with the still-active legacy
 * path. Results are persisted as hashes/status only; message text is not copied
 * into readiness evidence.
 *
 * This function NEVER sends a message and never calls a transport.
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
    notDeliverable: 0,
    unsupportedProjector: 0,
    comparisonMissing: 0,
    failed: 0,
  }

  for (const row of rows) {
    const audience = asMessageAudience(row.audience)
    const channel = asMessageChannel(row.channel)

    if (!audience || !channel) {
      result.notDeliverable += 1
      await persistShadowProjectionEvidence({
        accountId: input.accountId,
        eventId: row.id,
        status: 'not_deliverable',
      })
      continue
    }

    if (!CURRENT_EVENT_PROJECTOR_REGISTRY.has(row.event_type, row.event_version)) {
      result.unsupportedProjector += 1
      await persistShadowProjectionEvidence({
        accountId: input.accountId,
        eventId: row.id,
        status: 'unsupported_projector',
        error: 'EVENT_PROJECTOR_NOT_REGISTERED',
      })
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
        await persistShadowProjectionEvidence({
          accountId: input.accountId,
          eventId: row.id,
          status: 'native_only',
          renderedText: rendered.text,
        })
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
        await persistShadowProjectionEvidence({
          accountId: input.accountId,
          eventId: row.id,
          status: 'comparison_missing',
          renderedText: rendered.text,
          error: 'LEGACY_NOTIFICATION_NOT_FOUND',
        })
        continue
      }

      const legacyText = legacy.fx_trade_request_id
        ? await renderFxTradeBusinessEventText({
            accountId: input.accountId,
            tradeRequestId: legacy.fx_trade_request_id,
            eventType: legacy.event_type,
          })
        : legacy.message_text

      if (rendered.text === legacyText) {
        result.matchedLegacy += 1
        await persistShadowProjectionEvidence({
          accountId: input.accountId,
          eventId: row.id,
          status: 'matched_legacy',
          renderedText: rendered.text,
          legacyText,
        })
      } else {
        result.mismatchedLegacy += 1
        await persistShadowProjectionEvidence({
          accountId: input.accountId,
          eventId: row.id,
          status: 'mismatched_legacy',
          renderedText: rendered.text,
          legacyText,
        })
      }
    } catch (error) {
      result.failed += 1
      const message = error instanceof Error ? error.message : String(error)
      try {
        await persistShadowProjectionEvidence({
          accountId: input.accountId,
          eventId: row.id,
          status: 'failed',
          error: message,
        })
      } catch (persistError) {
        console.error(
          `[business event shadow] failed to persist verification failure event=${row.event_type}@${row.event_version} id=${row.id.slice(0, 8)}:`,
          persistError,
        )
      }
      console.error(
        `[business event shadow] projection failed event=${row.event_type}@${row.event_version} id=${row.id.slice(0, 8)}:`,
        error,
      )
    }
  }

  return result
}

async function persistShadowProjectionEvidence(input: {
  accountId: string
  eventId: string
  status: Exclude<ShadowProjectionStatus, 'pending' | 'checking'>
  renderedText?: string
  legacyText?: string
  error?: string
}): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('business_event_outbox')
    .update({
      shadow_projection_status: input.status,
      shadow_projection_checked_at: new Date().toISOString(),
      shadow_projection_error: input.error?.slice(0, 1000) ?? null,
      shadow_render_hash: input.renderedText ? sha256(input.renderedText) : null,
      shadow_legacy_hash: input.legacyText ? sha256(input.legacyText) : null,
    })
    .eq('account_id', input.accountId)
    .eq('id', input.eventId)
    .eq('delivery_mode', 'shadow')
    .eq('shadow_projection_status', 'checking')
  if (error) throw error
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
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
