/**
 * Durable provider-neutral broadcast queue.
 *
 * No WhatsApp sends from API requests or browser loops. A protected worker
 * ticks one recipient at a time. Every item is pinned to account + connection
 * + provider, claimed before transport, and never blindly retried.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveTemplateRow } from '@/lib/whatsapp/template-body'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import {
  BroadcastError, deliverBroadcast,
  type BroadcastPlan,
} from '@/lib/whatsapp/broadcast-core'
import type { WhatsAppProvider } from '@/lib/whatsapp/transport/types'

export type BroadcastResumeScope = 'pending' | 'failed'
export interface BroadcastQueueResult {
  jobId: string
  state: 'queued' | 'leased' | 'paused' | 'completed'
  pending: number
}
interface ClaimedJob {
  job_id: string
  broadcast_id: string
  account_id: string
  connection_id: string
  provider: WhatsAppProvider
  lease_token: string
}
interface BroadcastRecipient {
  id: string
  provider: WhatsAppProvider | null
  connection_id: string | null
  template_params: unknown
  recipient_phone_snapshot: string | null
  contact: { phone: string | null } | Array<{ phone: string | null }> | null
}
interface BroadcastMetadata {
  id: string
  template_name: string
  template_language: string
  broadcast_header_media_url: string | null
}

function mapQueueError(error: { message: string; code?: string }): BroadcastError {
  const code = error.code ?? 'queue_failed'
  const status = code === 'P0002' ? 404 :
    ['P0001','55P03','23514'].includes(code) ? 409 :
      code === '22023' ? 400 : 500
  return new BroadcastError(code, error.message, status)
}

function normalizeHeaderMediaUrl(url: string | null | undefined): string | null {
  if (!url?.trim()) return null
  const value = url.trim()
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || value.length > 2048) {
      throw new Error('Invalid HTTPS URL')
    }
  } catch {
    throw new BroadcastError('invalid_media_url', 'Broadcast header media URL must use HTTPS', 400)
  }
  return value
}

/** Enqueue only a COMPLETE, tenant-owned, connection-pinned plan. */
export async function enqueueBroadcastDelivery(
  db: SupabaseClient,
  input: {
    accountId: string
    broadcastId: string
    scope?: BroadcastResumeScope
    headerMediaUrl?: string | null
  },
): Promise<BroadcastQueueResult> {
  const { data: campaign, error: campaignError } = await db.from('broadcasts')
    .select('id,template_name,template_language,broadcast_header_media_url')
    .eq('account_id', input.accountId).eq('id', input.broadcastId).maybeSingle()
  if (campaignError || !campaign) throw new BroadcastError('not_found', 'Campaign not found in this account', 404)
  const { data: firstRecipient, error: recipientError } = await db.from('broadcast_recipients')
    .select('provider,connection_id').eq('broadcast_id', input.broadcastId)
    .order('created_at', { ascending: true }).limit(1).maybeSingle()
  if (recipientError || !firstRecipient?.connection_id || !firstRecipient.provider) {
    throw new BroadcastError('incomplete_campaign', 'Campaign must be fully planned and pinned before enqueuing', 409)
  }
  const resolvedTemplate = await resolveTemplateRow(db, input.accountId, campaign.template_name, campaign.template_language)
  if (resolvedTemplate.malformed) throw new BroadcastError('template_malformed', 'Campaign template is malformed', 400)
  if (firstRecipient.provider === 'openwa' &&
    ['image','video','document'].includes(resolvedTemplate.row?.header_type ?? '')) {
    throw new BroadcastError('unsupported_capability', 'OpenWA cannot send Meta media-header templates', 400)
  }
  const headerMediaUrl = normalizeHeaderMediaUrl(input.headerMediaUrl)
  if (headerMediaUrl && firstRecipient.provider === 'openwa') {
    throw new BroadcastError('unsupported_capability', 'OpenWA broadcasts support text content only', 400)
  }
  // Media input is frozen before worker dispatch and survives restarts.
  // A resumed campaign cannot silently change a previously frozen header.
  if (campaign.broadcast_header_media_url && headerMediaUrl &&
    campaign.broadcast_header_media_url !== headerMediaUrl) {
    throw new BroadcastError('campaign_frozen', 'Broadcast media header has already been frozen', 409)
  }
  const { data, error } = await db.rpc('enqueue_broadcast_delivery_job', {
    p_account_id: input.accountId,
    p_broadcast_id: input.broadcastId,
    p_scope: input.scope ?? 'pending',
    p_header_media_url: headerMediaUrl,
  })
  if (error) throw mapQueueError(error)
  const job = (Array.isArray(data) ? data[0] : data) as
    { job_id: string; job_state: BroadcastQueueResult['state']; pending_count: number } | null
  if (!job?.job_id) throw new BroadcastError('queue_failed', 'Database returned no durable job', 500)
  return { jobId: job.job_id, state: job.job_state, pending: Number(job.pending_count) }
}

function contactPhone(row: BroadcastRecipient): string {
  const contact = Array.isArray(row.contact) ? row.contact[0] : row.contact
  // An enqueued campaign never follows future CRM contact edits.
  return row.recipient_phone_snapshot ?? sanitizePhoneForMeta(contact?.phone ?? '')
}

export interface BroadcastWorkerTick {
  claimed: number
  sent: number
  paused: number
  completed: number
  queued: number
  outcome: string
}

/**
 * One recipient per lease, intentionally bounded for serverless timeouts.
 * Claim+finish are atomic fenced service-role RPCs; no browser can invoke
 * them. A stale recipient "sending" is UNKNOWN, never another send.
 */
export async function processBroadcastDeliveryTick(
  workerId: string,
  db: SupabaseClient = supabaseAdmin(),
): Promise<BroadcastWorkerTick> {
  if (!workerId.trim()) throw new Error('BROADCAST_WORKER_ID_REQUIRED')
  const { data: claimRows, error: claimError } = await db.rpc('claim_broadcast_delivery_job', {
    p_worker_id: workerId,
  })
  if (claimError) throw mapQueueError(claimError)
  const job = ((Array.isArray(claimRows) ? claimRows[0] : claimRows) ?? null) as ClaimedJob | null
  if (!job) return { claimed: 0, sent: 0, paused: 0, completed: 0, queued: 0, outcome: 'idle' }

  let nextState: 'queued' | 'paused' | 'completed' = 'paused'
  let reason: string | null = 'UNEXPECTED_WORKER_TERMINATION'
  let sent = 0
  let delaySeconds = 0
  try {
    const { data: campaign, error: broadcastError } = await db.from('broadcasts')
      .select('id,template_name,template_language,broadcast_header_media_url')
      .eq('id', job.broadcast_id).eq('account_id', job.account_id).maybeSingle()
    if (broadcastError || !campaign) throw new Error('BROADCAST_OWNERSHIP_MISMATCH')

    // If the old lease died after claiming a recipient, even a request that
    // may have reached WhatsApp must never be replayed. Quarantine it first.
    const { data: inFlight, error: flightError } = await db.from('broadcast_recipients')
      .select('id').eq('broadcast_id', job.broadcast_id).eq('status', 'sending').limit(1)
    if (flightError) throw flightError
    if ((inFlight ?? []).length > 0) {
      const { error: quarantineError } = await db.from('broadcast_recipients')
        .update({ status: 'requires_reconciliation', error_message: 'WORKER_LEASE_RECOVERY' })
        .eq('broadcast_id', job.broadcast_id).eq('status', 'sending')
      if (quarantineError) throw quarantineError
      reason = 'UNSETTLED_PREVIOUS_PROVIDER_ATTEMPT'
    } else {
      const { count: unknownCount, error: unknownError } = await db.from('broadcast_recipients')
        .select('id', { count: 'exact', head: true }).eq('broadcast_id', job.broadcast_id)
        .eq('status', 'requires_reconciliation')
      if (unknownError) throw unknownError
      if ((unknownCount ?? 0) > 0) {
        reason = 'RECONCILIATION_REQUIRED'
      } else {
        const { data: row, error: rowError } = await db.from('broadcast_recipients')
          .select('id,provider,connection_id,template_params,recipient_phone_snapshot,contact:contacts(phone)')
          .eq('broadcast_id', job.broadcast_id).eq('status', 'pending')
          .order('created_at', { ascending: true }).limit(1).maybeSingle()
        if (rowError) throw rowError
        if (!row) {
          nextState = 'completed'
          reason = null
        } else {
          const recipient = row as BroadcastRecipient
          if (recipient.provider !== job.provider || recipient.connection_id !== job.connection_id) {
            throw new Error('CAMPAIGN_PROVIDER_BINDING_MISMATCH')
          }
          const phone = contactPhone(recipient)
          if (!recipient.recipient_phone_snapshot || !isValidE164(phone)) {
            const { error: invalidError } = await db.from('broadcast_recipients')
              .update({ status: 'failed', error_message: 'INVALID_RECIPIENT_PRE_DISPATCH' })
              .eq('broadcast_id', job.broadcast_id).eq('id', recipient.id).eq('status', 'pending')
            if (invalidError) throw invalidError
            reason = 'INVALID_RECIPIENT_PRE_DISPATCH'
          } else {
            const metadata = campaign as BroadcastMetadata
            const template = await resolveTemplateRow(db, job.account_id, metadata.template_name, metadata.template_language)
            if (template.malformed) throw new Error('MALFORMED_BROADCAST_TEMPLATE')
            if (job.provider === 'openwa' &&
              ['image','video','document'].includes(template.row?.header_type ?? '')) {
              throw new Error('OPENWA_MEDIA_HEADER_UNSUPPORTED')
            }
            const plan: BroadcastPlan = {
              accountId: job.account_id, broadcastId: job.broadcast_id,
              connectionId: job.connection_id, provider: job.provider,
              templateName: metadata.template_name, templateLanguage: template.language,
              templateRow: template.row, rejected: 0,
              planned: [{
                recipientRowId: recipient.id, phone, status: 'pending',
                params: Array.isArray(recipient.template_params)
                  ? recipient.template_params.filter((p): p is string => typeof p === 'string') : [],
                messageParams: metadata.broadcast_header_media_url
                  ? { headerMediaUrl: metadata.broadcast_header_media_url } : undefined,
              }],
            }
            const outcomes = await deliverBroadcast(db, plan)
            const outcome = outcomes[0]
            if (outcome?.status === 'sent') {
              sent = 1
              const { count: pending, error: countError } = await db.from('broadcast_recipients')
                .select('id', { count: 'exact', head: true })
                .eq('broadcast_id', job.broadcast_id).eq('status', 'pending')
              if (countError) throw countError
              if ((pending ?? 0) > 0) {
                nextState = 'queued'
                delaySeconds = job.provider === 'openwa' ? 30 : 15
                reason = null
              } else {
                nextState = 'completed'
                reason = null
              }
            } else if (outcome?.status === 'skipped') {
              // Another process already owns a recipient; never force it.
              reason = 'RECIPIENT_CLAIM_CONFLICT'
            } else {
              reason = outcome?.status === 'requires_reconciliation'
                ? 'RECONCILIATION_REQUIRED' : 'PRE_DISPATCH_DENIED_OR_INVALID'
            }
          }
        }
      }
    }
  } catch (error) {
    reason = error instanceof Error ? error.message.slice(0, 200) : 'WORKER_ERROR'
    console.error('[broadcast-worker] tick failed', {
      broadcastId: job.broadcast_id, reason,
    })
  }
  const { data: settled, error: settlementError } = await db.rpc('finish_broadcast_delivery_job', {
    p_job_id: job.job_id,
    p_lease_token: job.lease_token,
    p_state: nextState,
    p_delay_seconds: delaySeconds,
    p_reason: reason,
  })
  if (settlementError || settled !== true) {
    throw new Error('BROADCAST_WORKER_LEASE_LOST_OR_SETTLEMENT_FAILED')
  }
  return {
    claimed: 1, sent,
    paused: nextState === 'paused' ? 1 : 0,
    completed: nextState === 'completed' ? 1 : 0,
    queued: nextState === 'queued' ? 1 : 0,
    outcome: nextState === 'paused' ? reason ?? 'paused' : nextState,
  }
}
