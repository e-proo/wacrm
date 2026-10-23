import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createBroadcast, finalizeBroadcastStatus, BroadcastError } from './broadcast-core'

vi.mock('@/lib/whatsapp/transport/meta-adapter', () => ({
  resolveMetaTransport: vi.fn(async () => ({
    connectionId: 'conn-1',
    transport: { provider: 'meta_cloud', send: vi.fn() },
  })),
}))
vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: vi.fn(async () => ({ id: 'c1' })),
}))

const db = {} as SupabaseClient

describe('createBroadcast validation', () => {
  it('rejects a missing template_name', async () => {
    await expect(createBroadcast(db, 'acc', 'user', { templateName: '', recipients: [{ to: '+14155550123' }] }))
      .rejects.toMatchObject({ code: 'bad_request', status: 400 })
  })

  it('rejects an empty recipient list', async () => {
    await expect(createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients: [] }))
      .rejects.toBeInstanceOf(BroadcastError)
  })

  it('rejects more than 1000 recipients', async () => {
    const recipients = Array.from({ length: 1001 }, () => ({ to: '+14155550123' }))
    await expect(createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients }))
      .rejects.toMatchObject({ status: 400 })
  })
})

function makeDb(rpcResult: { data: unknown; error: unknown }) {
  const calls = { rpc: [] as { name: string; args: unknown }[], usedDirectInsert: 0 }
  const database = {
    from(table: string) {
      if (table === 'message_templates') {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }
        return chain
      }
      if (table === 'broadcasts' || table === 'broadcast_recipients') {
        calls.usedDirectInsert++
        return { insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'orphan' }, error: null }) }) }) }
      }
      throw new Error(`unexpected table: ${table}`)
    },
    rpc(name: string, args: unknown) {
      calls.rpc.push({ name, args })
      return Promise.resolve(rpcResult)
    },
  } as unknown as SupabaseClient
  return { db: database, calls }
}

describe('createBroadcast atomicity (#370)', () => {
  it('creates parent + recipients through the atomic RPC', async () => {
    const { db, calls } = makeDb({ data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }], error: null })
    const plan = await createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients: [{ to: '+14155550123' }] })
    expect(calls.rpc).toHaveLength(1)
    expect(calls.rpc[0].name).toBe('create_broadcast_with_recipients')
    expect(calls.usedDirectInsert).toBe(0)
    expect(plan.broadcastId).toBe('b-1')
    expect(plan.accountId).toBe('acc')
    expect(plan.connectionId).toBe('conn-1')
    expect(plan.planned).toEqual([{ recipientRowId: 'r-1', phone: '14155550123', params: [] }])
  })

  it('throws and leaves no orphaned parent when atomic create fails', async () => {
    const { db, calls } = makeDb({ data: null, error: { message: 'recipient insert failed' } })
    await expect(createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients: [{ to: '+14155550123' }] }))
      .rejects.toBeInstanceOf(BroadcastError)
    expect(calls.rpc).toHaveLength(1)
    expect(calls.usedDirectInsert).toBe(0)
  })
})

function statusDb(counts: Record<string, number>, total: number, writes: { update?: Record<string, unknown> }) {
  return {
    from(table: string) {
      let status: string | null = null
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => { if (col === 'status') status = val as string; return b },
        update: (row: Record<string, unknown>) => { if (table === 'broadcasts') writes.update = row; return b },
        then: (resolve: (r: { count: number; error: null }) => unknown) => resolve({ count: status === null ? total : (counts[status] ?? 0), error: null }),
      }
      return b
    },
  } as unknown as SupabaseClient
}

describe('finalizeBroadcastStatus', () => {
  it('leaves sending while recipients are pending', async () => {
    const writes: { update?: Record<string, unknown> } = {}
    await finalizeBroadcastStatus(statusDb({ pending: 25 }, 1025, writes), 'b-1')
    expect(writes.update).toBeUndefined()
  })

  it('marks a fully-failed broadcast failed', async () => {
    const writes: { update?: Record<string, unknown> } = {}
    await finalizeBroadcastStatus(statusDb({ pending: 0, failed: 10 }, 10, writes), 'b-1')
    expect(writes.update?.status).toBe('failed')
  })

  it('marks a partially-failed broadcast sent', async () => {
    const writes: { update?: Record<string, unknown> } = {}
    await finalizeBroadcastStatus(statusDb({ pending: 0, failed: 3 }, 10, writes), 'b-1')
    expect(writes.update?.status).toBe('sent')
  })
})
