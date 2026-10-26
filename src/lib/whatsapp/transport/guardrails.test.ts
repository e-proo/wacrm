import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { GuardedOpenWATransport } from './guardrails'
import { WhatsAppTransportError, type WhatsAppTransport, type WhatsAppTransportSendResult } from './types'

const request = { accountId: 'acc-1', connectionId: 'conn-1', recipient: '967700000001', content: { kind: 'text' as const, text: 'hi' }, idempotencyKey: 'idem-1' }

function setup(reservation: Record<string, unknown>, sendImpl?: () => Promise<WhatsAppTransportSendResult>) {
  const rpc = vi.fn().mockResolvedValueOnce({ data: reservation, error: null }).mockResolvedValue({ data: null, error: null })
  const db = { rpc } as unknown as SupabaseClient
  const defaultSend = async (): Promise<WhatsAppTransportSendResult> => ({ provider: 'openwa', connectionId: 'conn-1', providerMessageId: 'p-1' })
  const inner: WhatsAppTransport = { provider: 'openwa', send: vi.fn(sendImpl ?? defaultSend) }
  return { rpc, inner, guarded: new GuardedOpenWATransport(db, inner) }
}

describe('OW-10 OpenWA guardrail transport', () => {
  it('blocks before provider call when reservation is denied', async () => {
    const { guarded, inner } = setup({ allowed: false, reason: 'daily_cap' })
    await expect(guarded.send(request)).rejects.toMatchObject({ code: 'connection_restricted' })
    expect(inner.send).not.toHaveBeenCalled()
  })
  it('reserves and records success without exposing recipient in audit arguments', async () => {
    const { guarded, rpc } = setup({ allowed: true, wait_ms: 0 })
    await guarded.send({ ...request, workload: 'broadcast' })
    expect(rpc).toHaveBeenNthCalledWith(1, 'reserve_openwa_guardrail_send', expect.objectContaining({ p_account_id: 'acc-1', p_connection_id: 'conn-1', p_workload: 'broadcast' }))
    const args = rpc.mock.calls[0][1] as Record<string, unknown>
    expect(args.p_recipient_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(args)).not.toContain(request.recipient)
    expect(rpc).toHaveBeenNthCalledWith(2, 'record_openwa_guardrail_outcome', expect.objectContaining({ p_success: true }))
  })
  it('records provider failure and preserves the original transport error', async () => {
    const providerError = new WhatsAppTransportError('connection_restricted', 'logged out')
    const { guarded, rpc } = setup({ allowed: true, wait_ms: 0 }, async () => { throw providerError })
    await expect(guarded.send(request)).rejects.toBe(providerError)
    expect(rpc).toHaveBeenNthCalledWith(2, 'record_openwa_guardrail_outcome', expect.objectContaining({ p_success: false, p_reason: 'connection_restricted' }))
  })
  it('fails closed if guardrail reservation cannot be persisted', async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'db unavailable' } }) } as unknown as SupabaseClient
    const inner: WhatsAppTransport = { provider: 'openwa', send: vi.fn() }
    await expect(new GuardedOpenWATransport(db, inner).send(request)).rejects.toMatchObject({ code: 'retryable_provider_failure' })
    expect(inner.send).not.toHaveBeenCalled()
  })
})
