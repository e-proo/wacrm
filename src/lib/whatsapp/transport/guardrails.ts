import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { WhatsAppTransportError, type WhatsAppTransport, type WhatsAppTransportSendRequest, type WhatsAppTransportSendResult } from './types'

interface Reservation { allowed?: boolean; reason?: string; wait_ms?: number }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const recipientHash = (accountId: string, connectionId: string, recipient: string) => createHash('sha256').update(`${accountId}:${connectionId}:${recipient}`).digest('hex')

export class GuardedOpenWATransport implements WhatsAppTransport {
  readonly provider = 'openwa' as const
  constructor(private readonly db: SupabaseClient, private readonly inner: WhatsAppTransport) {}

  async send(request: WhatsAppTransportSendRequest): Promise<WhatsAppTransportSendResult> {
    const workload = request.workload ?? 'manual'
    const hash = recipientHash(request.accountId, request.connectionId, request.recipient)
    const { data, error } = await this.db.rpc('reserve_openwa_guardrail_send', {
      p_account_id: request.accountId,
      p_connection_id: request.connectionId,
      p_recipient_hash: hash,
      p_workload: workload,
    })
    if (error) throw new WhatsAppTransportError('retryable_provider_failure', 'Could not reserve OpenWA guardrail capacity', error)
    const reservation = (data ?? {}) as Reservation
    if (!reservation.allowed) throw new WhatsAppTransportError('connection_restricted', `OpenWA send blocked by WACRM guardrail: ${reservation.reason ?? 'policy'}`)
    const waitMs = Math.max(0, Math.min(Number(reservation.wait_ms ?? 0), 600_000))
    if (waitMs > 0) await sleep(waitMs)
    try {
      const result = await this.inner.send(request)
      await this.record(request, hash, true)
      return result
    } catch (error) {
      await this.record(request, hash, false, error instanceof WhatsAppTransportError ? error.code : 'provider_failure')
      throw error
    }
  }

  private async record(request: WhatsAppTransportSendRequest, hash: string, success: boolean, reason?: string) {
    const { error } = await this.db.rpc('record_openwa_guardrail_outcome', {
      p_account_id: request.accountId,
      p_connection_id: request.connectionId,
      p_recipient_hash: hash,
      p_workload: request.workload ?? 'manual',
      p_success: success,
      p_reason: reason ?? null,
    })
    if (error) console.error('[openwa-guardrail] outcome audit failed', { connectionId: request.connectionId, success })
  }
}
