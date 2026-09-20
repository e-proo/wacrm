import { supabaseAdmin } from '@/lib/ai/admin-client'

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
