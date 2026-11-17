/**
 * Protected TEST queue processor for signed OpenWA events whose identity or
 * native ACK was not yet matchable at intake.
 *
 * Never initiates a resend. Resolved inbound events enter the SAME WACRM
 * customer/agent/automation pipeline used by ordinary signed webhooks.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { processNormalizedInboundMessage } from '@/lib/whatsapp/inbound-processor'
import { applyWhatsAppStatus } from '@/lib/whatsapp/status-lifecycle'
import { preflightOpenWAInboundIdentity, readDeferredInbound, readDeferredStatus } from './deferred'

interface DeferredJob {
  job_id: string
  account_id: string
  connection_id: string
  session_id: string
  own_phone_identity: string | null
  instance_id: string | null
  event_kind: 'unresolved_identity' | 'unmatched_status'
  provider_message_id: string
  native_chat_id: string | null
  normalized_payload: unknown
  attempt_count: number
  lease_token: string
}

type Outcome = { state: 'completed' | 'pending' | 'review'; reason: string | null }

function adminDb(): SupabaseClient {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('OpenWA deferred worker database configuration missing')
  }
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
}

function retry(reason: string): Outcome { return { state: 'pending', reason } }
function review(reason: string): Outcome { return { state: 'review', reason } }
const COMPLETE: Outcome = { state: 'completed', reason: null }

async function processDeferredJob(db: SupabaseClient, job: DeferredJob): Promise<Outcome> {
  const { data: connection, error } = await db.from('whatsapp_connections')
    .select('id,status,phone_identity,instance_id')
    .eq('id', job.connection_id).eq('account_id', job.account_id)
    .eq('provider', 'openwa').eq('session_id', job.session_id)
    .is('archived_at', null).maybeSingle()
  if (error) return retry('connection_lookup_unavailable')
  if (!connection) return review('connection_binding_changed')
  if (connection.phone_identity !== job.own_phone_identity ||
      connection.instance_id !== job.instance_id) return review('session_identity_changed')
  if (!['ready','connected'].includes(connection.status)) return retry('session_not_ready')

  if (job.event_kind === 'unmatched_status') {
    const status = readDeferredStatus(job.normalized_payload)
    if (!status) return review('invalid_deferred_status')
    const outcome = await applyWhatsAppStatus(db, {
      provider: 'openwa', accountId: job.account_id,
      connectionId: job.connection_id,
      providerMessageId: job.provider_message_id,
      ...status,
    })
    return outcome === 'unknown' ? retry('native_message_not_found') : COMPLETE
  }

  if (job.event_kind !== 'unresolved_identity' || !job.native_chat_id) {
    return review('unsupported_deferred_event')
  }
  const inbound = readDeferredInbound(
    job.normalized_payload, job.connection_id,
    job.provider_message_id, job.native_chat_id,
  )
  if (!inbound) return review('invalid_deferred_identity')
  const identity = await preflightOpenWAInboundIdentity(db, {
    accountId: job.account_id, connectionId: job.connection_id,
    sessionId: job.session_id, inbound,
  })
  if (identity === 'unresolved') return retry('sender_phone_unresolved')
  const { data: account, error: ownerError } = await db.from('accounts')
    .select('owner_user_id').eq('id', job.account_id).maybeSingle()
  if (ownerError || !account?.owner_user_id) return retry('account_owner_unavailable')

  await processNormalizedInboundMessage(
    inbound.message, inbound.contact, job.account_id, job.connection_id,
    account.owner_user_id, '', true,
    // Deferred media retains only provider-native IDs; no inline base64.
    undefined,
  )

  if (inbound.message.type !== 'reaction') {
    // The existing inbound processor treats several storage failures as a
    // best-effort return. Do not mark the deferred job complete without
    // proof that its provider message was actually persisted.
    const { data: stored, error: storedError } = await db.from('messages')
      .select('id').eq('connection_id', job.connection_id)
      .eq('provider', 'openwa').eq('provider_message_id', job.provider_message_id)
      .eq('sender_type', 'customer').limit(1).maybeSingle()
    if (storedError || !stored) return retry('inbound_persistence_unconfirmed')
  }
  return COMPLETE
}

function nextRetrySeconds(attemptCount: number): number {
  return Math.min(21_600, 60 * (2 ** Math.min(9, Math.max(0, attemptCount - 1))))
}

/** Runs one bounded, database-leased batch; no mutable process-local queue. */
export async function processOpenWADeferredTick(
  db: SupabaseClient = adminDb(),
): Promise<{ claimed: number; completed: number; pending: number; review: number }> {
  const { data, error } = await db.rpc('claim_openwa_deferred_events', { p_limit: 5 })
  if (error) throw new Error('Could not claim OpenWA deferred events')
  const jobs = (data ?? []) as DeferredJob[]
  const result = { claimed: jobs.length, completed: 0, pending: 0, review: 0 }

  for (const job of jobs) {
    let outcome: Outcome
    try {
      outcome = await processDeferredJob(db, job)
    } catch {
      // No untrusted upstream error text enters SQL/logs.
      outcome = retry('deferred_processing_failed')
    }
    const { data: finished, error: finishError } = await db.rpc('finish_openwa_deferred_event', {
      p_job_id: job.job_id, p_lease_token: job.lease_token,
      p_outcome: outcome.state,
      p_delay_seconds: outcome.state === 'pending' ? nextRetrySeconds(job.attempt_count) : 0,
      p_reason: outcome.reason,
    })
    if (finishError || finished !== true) {
      // Lease has expired or DB unavailable: do not claim success.
      throw new Error('OpenWA deferred event lease could not be finalized')
    }
    result[outcome.state] += 1
  }
  return result
}
