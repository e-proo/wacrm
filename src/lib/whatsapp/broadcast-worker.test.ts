import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  send: vi.fn(),
  template: vi.fn(),
}))
vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: h.template,
}))
vi.mock('./broadcast-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./broadcast-core')>()),
  deliverBroadcast: h.send,
}))
import { enqueueBroadcastDelivery, processBroadcastDeliveryTick } from './broadcast-worker'

const CLAIM = {
  job_id: 'job-1', broadcast_id: 'broadcast-1', account_id: 'account-1',
  connection_id: 'connection-1', provider: 'openwa', lease_token: 'token-1',
}
const CAMPAIGN = {
  id: 'broadcast-1', template_name: 'greeting', template_language: 'en',
  broadcast_header_media_url: null,
}
const RECIPIENT = {
  id: 'recipient-1', provider: 'openwa', connection_id: 'connection-1',
  template_params: ['Ali'], recipient_phone_snapshot: '967700000001', contact: { phone: '+967700000002' },
}
interface Fixture {
  claim?: typeof CLAIM | null
  campaign?: typeof CAMPAIGN | null
  recipient?: typeof RECIPIENT | null
  inFlight?: boolean
  unknownCount?: number
  pendingCount?: number
  settleResult?: boolean
}
function fakeDb(fixture: Fixture = {}) {
  const calls = {
    rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
    updates: [] as Array<{ table: string; status: unknown }>,
  }
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.rpc.push({ name, args })
      if (name === 'claim_broadcast_delivery_job') return { data: fixture.claim === undefined ? [CLAIM] : fixture.claim ? [fixture.claim] : [], error: null }
      if (name === 'finish_broadcast_delivery_job') return { data: fixture.settleResult ?? true, error: null }
      if (name === 'enqueue_broadcast_delivery_job') return { data: [{ job_id: 'job-1', job_state: 'queued', pending_count: 2 }], error: null }
      throw new Error('Unexpected RPC: ' + name)
    },
    from: (table: string) => {
      const filters: Record<string, unknown> = {}
      let countQuery = false
      const q: Record<string, unknown> = {
        select: (_columns: string, options?: { count?: string }) => { countQuery = options?.count === 'exact'; return q },
        eq: (name: string, value: unknown) => { filters[name] = value; return q },
        order: () => q,
        limit: () => q,
        update: (value: { status?: string }) => { calls.updates.push({ table, status: value.status }); return q },
        maybeSingle: async () => {
          if (table === 'broadcasts') return { data: fixture.campaign === undefined ? CAMPAIGN : fixture.campaign, error: null }
          if (table === 'broadcast_recipients') {
            if (filters.status === 'pending') return { data: fixture.recipient === undefined ? RECIPIENT : fixture.recipient, error: null }
            return { data: { provider: 'openwa', connection_id: 'connection-1' }, error: null }
          }
          throw new Error('Unexpected maybeSingle from ' + table)
        },
        then: (resolve: (value: { data?: unknown[]; count?: number; error: null }) => unknown) => {
          if (table === 'broadcast_recipients' && filters.status === 'sending') {
            return Promise.resolve(resolve({ data: fixture.inFlight ? [{ id: 'previous' }] : [], error: null }))
          }
          if (countQuery && filters.status === 'requires_reconciliation') {
            return Promise.resolve(resolve({ data: [], count: fixture.unknownCount ?? 0, error: null }))
          }
          if (countQuery && filters.status === 'pending') {
            return Promise.resolve(resolve({ data: [], count: fixture.pendingCount ?? 1, error: null }))
          }
          return Promise.resolve(resolve({ data: [], error: null }))
        },
      }
      return q
    },
  } as unknown as SupabaseClient
  return { db, calls }
}
describe('durable campaign queue + recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.template.mockResolvedValue({ malformed: false, language: 'en', row: { body_text: 'Hello {{1}}' } })
    h.send.mockResolvedValue([{ status: 'sent', recipientId: 'recipient-1' }])
  })

  it('enqueues an account-scoped frozen broadcast instead of sending inline', async () => {
    const { db, calls } = fakeDb()
    const result = await enqueueBroadcastDelivery(db, { accountId: 'account-1', broadcastId: 'broadcast-1' })
    expect(result).toMatchObject({ jobId: 'job-1', pending: 2, state: 'queued' })
    expect(calls.rpc).toEqual([{
      name: 'enqueue_broadcast_delivery_job',
      args: { p_account_id: 'account-1', p_broadcast_id: 'broadcast-1', p_scope: 'pending', p_header_media_url: null },
    }])
    expect(h.send).not.toHaveBeenCalled()
  })

  it('idles safely when no SQL claim is available', async () => {
    const { db } = fakeDb({ claim: null })
    expect(await processBroadcastDeliveryTick('worker-1', db)).toMatchObject({ claimed: 0, sent: 0, outcome: 'idle' })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('leases a single recipient and schedules next bounded tick after confirmed send', async () => {
    const { db, calls } = fakeDb({ pendingCount: 1 })
    const result = await processBroadcastDeliveryTick('worker-1', db)
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send).toHaveBeenCalledWith(db, expect.objectContaining({
      accountId: 'account-1', connectionId: 'connection-1', provider: 'openwa',
      planned: [expect.objectContaining({ recipientRowId: 'recipient-1', phone: '967700000001', status: 'pending' })],
    }))
    expect(result).toMatchObject({ claimed: 1, sent: 1, queued: 1 })
    expect(calls.rpc.at(-1)).toEqual({
      name: 'finish_broadcast_delivery_job',
      args: { p_job_id: 'job-1', p_lease_token: 'token-1', p_state: 'queued', p_delay_seconds: 30, p_reason: null },
    })
  })

  it('quarantines a stale in-flight attempt and NEVER retries it', async () => {
    const { db, calls } = fakeDb({ inFlight: true })
    const result = await processBroadcastDeliveryTick('worker-1', db)
    expect(result).toMatchObject({ claimed: 1, sent: 0, paused: 1, outcome: 'UNSETTLED_PREVIOUS_PROVIDER_ATTEMPT' })
    expect(calls.updates).toContainEqual({ table: 'broadcast_recipients', status: 'requires_reconciliation' })
    expect(h.send).not.toHaveBeenCalled()
    expect(calls.rpc.at(-1)?.args).toMatchObject({ p_state: 'paused', p_lease_token: 'token-1' })
  })

  it('blocks pending fanout while a prior recipient needs reconciliation', async () => {
    const { db } = fakeDb({ unknownCount: 1 })
    const result = await processBroadcastDeliveryTick('worker-1', db)
    expect(result.paused).toBe(1)
    expect(h.send).not.toHaveBeenCalled()
  })

  it('pauses rather than resends a provider-ambiguous outcome', async () => {
    const { db, calls } = fakeDb()
    h.send.mockResolvedValueOnce([{ status: 'requires_reconciliation', recipientId: 'recipient-1' }])
    const result = await processBroadcastDeliveryTick('worker-1', db)
    expect(result.paused).toBe(1)
    expect(result.sent).toBe(0)
    expect(calls.rpc.at(-1)?.args).toMatchObject({ p_state: 'paused', p_reason: 'RECONCILIATION_REQUIRED' })
  })

  it('completes the campaign only through the fenced SQL settlement', async () => {
    const { db, calls } = fakeDb({ pendingCount: 0 })
    const result = await processBroadcastDeliveryTick('worker-1', db)
    expect(result).toMatchObject({ completed: 1, sent: 1 })
    expect(calls.rpc.at(-1)?.args).toMatchObject({ p_state: 'completed', p_lease_token: 'token-1' })
  })

  it('rejects a stolen or expired worker lease', async () => {
    const { db } = fakeDb({ settleResult: false })
    await expect(processBroadcastDeliveryTick('worker-1', db)).rejects.toThrow('LEASE_LOST')
  })
})
