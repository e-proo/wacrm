import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  processInbound: vi.fn(), applyStatus: vi.fn(), preflight: vi.fn(),
  readInbound: vi.fn(), readStatus: vi.fn(),
  resolveClient: vi.fn(), nativeLookup: vi.fn(),
}))
vi.mock('@/lib/whatsapp/inbound-processor', () => ({
  processNormalizedInboundMessage: h.processInbound,
}))
vi.mock('@/lib/whatsapp/status-lifecycle', () => ({ applyWhatsAppStatus: h.applyStatus }))
vi.mock('./deferred', () => ({
  preflightOpenWAInboundIdentity: h.preflight,
  readDeferredInbound: h.readInbound,
  readDeferredStatus: h.readStatus,
}))
vi.mock('./credentials', () => ({ resolveOpenWAClient: h.resolveClient }))
import { processOpenWADeferredTick } from './deferred-worker'

function job(kind: 'unresolved_identity' | 'unmatched_status' = 'unresolved_identity') {
  return {
    job_id: 'job', account_id: 'acct', connection_id: 'conn', session_id: 'sess',
    own_phone_identity: 'owner-phone', instance_id: 'instance',
    event_kind: kind, provider_message_id: 'native1',
    native_chat_id: kind === 'unresolved_identity' ? '123456789012345@lid' : null,
    verified_phone: null as string | null, verification_source: null as string | null,
    verified_at: null as string | null,
    normalized_payload: {}, attempt_count: 1, lease_token: 'lease',
  }
}

function fixture(options: {
  connection?: null | Record<string, unknown>
  jobs?: ReturnType<typeof job>[]
  stored?: boolean
  owner?: boolean
} = {}) {
  const finished: Record<string, unknown>[] = []
  const connection = options.connection === undefined ? {
    id: 'conn', status: 'ready', phone_identity: 'owner-phone', instance_id: 'instance',
  } : options.connection
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'prune_openwa_deferred_events') return { data: 0, error: null }
    if (fn === 'claim_openwa_deferred_events_for_mode') return { data: options.jobs ?? [job()], error: null }
    if (fn === 'finish_openwa_deferred_event') {
      finished.push(args)
      return { data: true, error: null }
    }
    throw new Error(fn)
  })
  const from = vi.fn((table: string) => {
    const query = {
      select: () => query, eq: () => query, is: () => query, limit: () => query,
      maybeSingle: async () => ({
        data: table === 'whatsapp_connections' ? connection
          : table === 'accounts' ? (options.owner === false ? null : { owner_user_id: 'owner' })
          : table === 'messages' && options.stored !== false ? { id: 'saved' } : null,
        error: null,
      }),
    }
    return query
  })
  return { db: { rpc, from } as unknown as SupabaseClient, finished, from, rpc }
}
const native = {
  message: {
    id: 'native1', provider: 'openwa', connectionId: 'conn',
    providerMessageId: 'native1', from: '123456789012345@lid', providerChatId: '123456789012345@lid',
    timestamp: '1792950000', type: 'text', text: { body: 'Hi' },
  },
  contact: { profile: { name: 'New' }, wa_id: '123456789012345@lid' },
}

beforeEach(() => {
  vi.clearAllMocks()
  h.readInbound.mockReturnValue(structuredClone(native))
  h.readStatus.mockReturnValue({ status: 'delivered' })
  h.preflight.mockResolvedValue('ready')
  h.applyStatus.mockResolvedValue('updated')
  h.processInbound.mockResolvedValue(undefined)
  h.resolveClient.mockResolvedValue({ client: { request: h.nativeLookup } })
  h.nativeLookup.mockResolvedValue({ lid: '123456789012345@lid' })
})

describe('OpenWA deferred worker', () => {
  it('runs a resolved unknown sender through the unified inbound processor once', async () => {
    const f = fixture()
    expect(await processOpenWADeferredTick(f.db)).toEqual({ claimed: 1, completed: 1, pending: 0, review: 0 })
    expect(h.processInbound).toHaveBeenCalledWith(
      expect.objectContaining({ providerMessageId: 'native1' }),
      expect.anything(), 'acct', 'conn', 'owner', '', true, undefined,
    )
    expect(f.finished[0]).toMatchObject({ p_job_id: 'job', p_lease_token: 'lease', p_outcome: 'completed' })
  })
  it('keeps an unmapped sender pending and never invokes any agent', async () => {
    h.preflight.mockResolvedValue('unresolved')
    const f = fixture()
    expect(await processOpenWADeferredTick(f.db)).toMatchObject({ pending: 1, completed: 0 })
    expect(f.finished[0]).toMatchObject({ p_outcome: 'pending', p_reason: 'sender_phone_unresolved' })
    expect(h.processInbound).not.toHaveBeenCalled()
  })
  it('blocks a re-linked instance from reinterpreting an old native LID', async () => {
    const f = fixture({ connection: {
      id: 'conn', status: 'ready', phone_identity: 'different-phone', instance_id: 'instance',
    } })
    expect(await processOpenWADeferredTick(f.db)).toMatchObject({ review: 1 })
    expect(f.finished[0]).toMatchObject({ p_reason: 'session_identity_changed' })
    expect(h.preflight).not.toHaveBeenCalled()
  })
  it('rejects a missing tenant-scoped connection', async () => {
    const f = fixture({ connection: null })
    expect(await processOpenWADeferredTick(f.db)).toMatchObject({ review: 1 })
    expect(h.processInbound).not.toHaveBeenCalled()
  })
  it('does not mark a best-effort inbound processor return complete without saved message proof', async () => {
    const f = fixture({ stored: false })
    expect(await processOpenWADeferredTick(f.db)).toMatchObject({ pending: 1 })
    expect(f.finished[0]).toMatchObject({ p_reason: 'inbound_persistence_unconfirmed' })
  })
  it('settles native receipts without sending WhatsApp and retries unmatched rows', async () => {
    h.applyStatus.mockResolvedValueOnce('unknown').mockResolvedValueOnce('updated')
    const f = fixture({ jobs: [job('unmatched_status'), { ...job('unmatched_status'), job_id: 'job2', lease_token: 'lease2' }] })
    expect(await processOpenWADeferredTick(f.db)).toMatchObject({ claimed: 2, completed: 1, pending: 1 })
    expect(h.applyStatus).toHaveBeenCalledWith(f.db, expect.objectContaining({
      provider: 'openwa', connectionId: 'conn', accountId: 'acct',
      providerMessageId: 'native1', status: 'delivered',
    }))
    expect(h.processInbound).not.toHaveBeenCalled()
  })
  it('reverifies a fresh admin-supplied phone from the exact provider session before CRM dispatch', async () => {
    const verified = {
      ...job(), verified_phone: '967700000001', verification_source: 'openwa_reverse_lid',
      verified_at: new Date().toISOString(),
    }
    const f = fixture({ jobs: [verified] })
    expect(await processOpenWADeferredTick(f.db)).toMatchObject({ completed: 1 })
    expect(h.nativeLookup).toHaveBeenCalledWith(
      '/api/sessions/sess/contacts/967700000001/lid', { timeoutMs: 7000 },
    )
    expect(h.processInbound).toHaveBeenCalledWith(
      expect.objectContaining({ from: '967700000001', providerChatId: '123456789012345@lid' }),
      expect.objectContaining({ wa_id: '967700000001' }),
      'acct', 'conn', 'owner', '', true, undefined,
    )
  })
  it('does not trust an expired phone proof even if stored by an admin', async () => {
    const verified = {
      ...job(), verified_phone: '967700000001', verification_source: 'openwa_reverse_lid',
      verified_at: new Date(Date.now() - 48 * 3600_000).toISOString(),
    }
    const f = fixture({ jobs: [verified] })
    expect(await processOpenWADeferredTick(f.db)).toMatchObject({ review: 1 })
    expect(h.processInbound).not.toHaveBeenCalled()
    expect(h.nativeLookup).not.toHaveBeenCalled()
  })
  it('quarantines changed phone-to-LID mappings rather than assigning a wrong contact', async () => {
    h.nativeLookup.mockResolvedValueOnce({ lid: '444444444444444@lid' })
    const verified = {
      ...job(), verified_phone: '967700000001', verification_source: 'openwa_reverse_lid',
      verified_at: new Date().toISOString(),
    }
    const f = fixture({ jobs: [verified] })
    expect(await processOpenWADeferredTick(f.db)).toMatchObject({ review: 1 })
    expect(h.processInbound).not.toHaveBeenCalled()
  })
  it('defers after a transient DB failure rather than losing the work', async () => {
    h.preflight.mockRejectedValueOnce(new Error('temporary failure'))
    const f = fixture()
    expect(await processOpenWADeferredTick(f.db)).toMatchObject({ pending: 1 })
    expect(f.finished[0]).toMatchObject({ p_reason: 'deferred_processing_failed' })
  })
})
