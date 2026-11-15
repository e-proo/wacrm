import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isOpenWATestProject,
  openWAPilotRecipientHash,
} from '@/lib/whatsapp/transport/guardrails'
import { normalizeTestRecipient } from '@/lib/whatsapp/transport/openwa/pilot-recipient-input'
import { resolveOpenWAPilotRecipientForGrant } from '@/lib/whatsapp/transport/openwa/pilot-recipient'

export type OpenWATaskDeferralReason =
  | 'connection_not_ready'
  | 'connection_paused'
  | 'connection_circuit_open'
  | 'pilot_guardrail_missing'
  | 'pilot_recipient_not_verified'
  | 'pilot_recipient_not_approved'

/**
 * TEST-only preclaim protection.
 *
 * Missing/expired grants or a paused OpenWA session are a temporary *wait*,
 * not grounds to consume a Task Run's only attempt or terminalize a
 * pre-dispatch reservation. All actual sends still use their full, separate
 * authoritative transport admission check and durable reservation.
 *
 * No raw phone/JID is stored or logged here; lookups are tenant + connection
 * scoped. Meta and non-TEST behavior are intentionally unchanged.
 */
export async function deferredTestOpenWATaskReason(input: {
  db: SupabaseClient
  accountId: string
  connectionId: string | null
  contactIds?: readonly string[]
}): Promise<OpenWATaskDeferralReason | null> {
  if (!isOpenWATestProject() || !input.connectionId) return null
  const { db, accountId, connectionId } = input
  const { data: connection, error: connectionError } = await db
    .from('whatsapp_connections')
    .select('provider,status,archived_at')
    .eq('account_id', accountId)
    .eq('id', connectionId)
    .maybeSingle()
  if (connectionError) throw connectionError
  if (!connection || connection.archived_at ||
      !['ready','connected'].includes(connection.status)) {
    return 'connection_not_ready'
  }
  if (connection.provider !== 'openwa') return null

  const { data: guard, error: guardError } = await db
    .from('whatsapp_connection_guardrails')
    .select('manual_paused,pilot_enabled,circuit_open_until')
    .eq('account_id', accountId)
    .eq('connection_id', connectionId)
    .maybeSingle()
  if (guardError) throw guardError
  if (!guard) return 'pilot_guardrail_missing'
  if (guard.manual_paused) return 'connection_paused'
  if (guard.circuit_open_until &&
      new Date(guard.circuit_open_until).getTime() > Date.now()) {
    return 'connection_circuit_open'
  }

  // This admin-controlled TEST setting intentionally permits normal sending.
  // It does not disable the shared guardrail/budget/consent enforcement.
  if (guard.pilot_enabled === false) return null

  const contactIds = [...new Set(input.contactIds ?? [])]
  if (!contactIds.length) {
    // A dynamic Task has not frozen its recipients here yet. The outbound
    // per-target check runs once the SQL materializer creates its targets.
    return null
  }

  const { data: scoped, error: contactsError } = await db.from('contacts')
    .select('id,phone')
    .eq('account_id', accountId)
    .in('id', contactIds)
    .limit(contactIds.length)
  if (contactsError) throw contactsError
  const phones = new Map((scoped ?? []).map(row => [row.id, row.phone]))
  if (phones.size !== contactIds.length) return 'pilot_recipient_not_verified'

  const hashes: string[] = []
  for (const contactId of contactIds) {
    const phone = phones.get(contactId)
    const normalized = typeof phone === 'string'
      ? normalizeTestRecipient(phone) : null
    if (!normalized) return 'pilot_recipient_not_verified'

    // Resolve the same native chat identity used by the session pilot grant.
    // An unknown or ambiguous native chat is not a valid Agent first touch.
    let recipient: string
    try {
      const resolved = await resolveOpenWAPilotRecipientForGrant(
        db, accountId, connectionId, normalized,
      )
      if (resolved.source !== 'verified_inbound_chat') {
        return 'pilot_recipient_not_verified'
      }
      recipient = resolved.recipient
    } catch {
      return 'pilot_recipient_not_verified'
    }

    const { data: recent, error: recentError } = await db.from('messages')
      .select('id')
      .eq('connection_id', connectionId)
      .eq('provider', 'openwa')
      .eq('sender_type', 'customer')
      .eq('provider_chat_id', recipient)
      .gte('created_at', new Date(Date.now() - 24 * 3600_000).toISOString())
      .limit(1)
    if (recentError) throw recentError
    if (!recent?.length) return 'pilot_recipient_not_verified'

    const hash = openWAPilotRecipientHash(accountId, connectionId, recipient)
    if (!hash) return 'pilot_recipient_not_verified'
    hashes.push(hash)
  }
  const { data: granted, error: grantsError } = await db
    .from('whatsapp_openwa_pilot_allowlist')
    .select('recipient_hash')
    .eq('account_id', accountId)
    .eq('connection_id', connectionId)
    .eq('workload', 'agent')
    .eq('active', true)
    .gt('expires_at', new Date().toISOString())
    .in('recipient_hash', hashes)
    .limit(hashes.length)
  if (grantsError) throw grantsError
  return new Set((granted ?? []).map(g => g.recipient_hash)).size === hashes.length
    ? null : 'pilot_recipient_not_approved'
}
