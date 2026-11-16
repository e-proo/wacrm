import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { OpenWAPreDispatchDenied } from './transport/guardrails'
import { WhatsAppTransportError } from './transport/types'
const h = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('./transport/router', () => ({ resolveWhatsAppTransport: h.resolve }))
import { deliverBroadcast, type BroadcastPlan } from './broadcast-core'
function setupDatabase() {
  const writes: Record<string, unknown>[] = []
  const db = { from: (table: string) => {
    if (table !== 'broadcast_recipients') throw new Error('Unexpected table ' + table)
    const q: Record<string, unknown> = {
      update: (value: Record<string, unknown>) => { writes.push(value); return q },
      eq: () => q,
      select: () => q,
      maybeSingle: async () => ({ data: { id: 'recipient-1' }, error: null }),
      then: (cb: (value: { data: null; error: null }) => unknown) => Promise.resolve(cb({ data: null, error: null })),
    }
    return q
  } } as unknown as SupabaseClient
  return { db, writes }
}
function plan(): BroadcastPlan {
  return {
    accountId: 'account-1', connectionId: 'connection-1', provider: 'openwa',
    broadcastId: 'broadcast-1', templateName: 'greeting', templateLanguage: 'en',
    templateRow: { body_text: 'Hi {{1}}' } as never,
    planned: [{ recipientRowId: 'recipient-1', phone: '967700000001', params: ['Ali'] }],
    rejected: 0,
  }
}
describe('provider-neutral durable campaign delivery', () => {
  beforeEach(() => vi.clearAllMocks())
  it('claims the target before the provider call and records native identity', async () => {
    const { db, writes } = setupDatabase()
    const send = vi.fn(async (request: unknown) => {
      expect(writes[0]).toMatchObject({ status: 'sending' })
      expect(request).toMatchObject({
        idempotencyKey: 'broadcast:broadcast-1:recipient-1',
        workload: 'broadcast', content: { kind: 'text', text: 'Hi Ali' },
      })
      return { provider: 'openwa', connectionId: 'connection-1', providerMessageId: 'native-id' }
    })
    h.resolve.mockResolvedValue({ connectionId: 'connection-1', transport: { provider: 'openwa', send } })
    const results = await deliverBroadcast(db, plan())
    expect(results).toMatchObject([{ status: 'sent', providerMessageId: 'native-id' }])
    expect(writes[1]).toMatchObject({ status: 'sent', provider_message_id: 'native-id' })
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('holds a timeout for reconciliation instead of flagging it retryable', async () => {
    const { db, writes } = setupDatabase()
    const send = vi.fn().mockRejectedValue(new WhatsAppTransportError('ambiguous_outcome', 'Timeout'))
    h.resolve.mockResolvedValue({ connectionId: 'connection-1', transport: { provider: 'openwa', send } })
    const results = await deliverBroadcast(db, plan())
    expect(results[0].status).toBe('requires_reconciliation')
    expect(writes[1]).toMatchObject({ status: 'requires_reconciliation', error_message: 'RECONCILIATION_REQUIRED' })
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('treats only proven pre-dispatch denials as unsent', async () => {
    const { db, writes } = setupDatabase()
    const send = vi.fn().mockRejectedValue(new OpenWAPreDispatchDenied('Pilot denied'))
    h.resolve.mockResolvedValue({ connectionId: 'connection-1', transport: { provider: 'openwa', send } })
    const results = await deliverBroadcast(db, {
      ...plan(), planned: [...plan().planned, { recipientRowId: 'recipient-2', phone: '967700000002', params: ['Sara'] }],
    })
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('failed')
    expect(writes[1]).toMatchObject({ status: 'failed', error_message: 'PRE_DISPATCH_DENIED' })
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('never retries an already-sending or unknown recipient', async () => {
    const { db, writes } = setupDatabase()
    const send = vi.fn()
    h.resolve.mockResolvedValue({ connectionId: 'connection-1', transport: { provider: 'openwa', send } })
    const results = await deliverBroadcast(db, {
      ...plan(), planned: [{ ...plan().planned[0], status: 'requires_reconciliation' }],
    })
    expect(results[0].status).toBe('skipped')
    expect(writes).toHaveLength(0)
    expect(send).not.toHaveBeenCalled()
  })
})
