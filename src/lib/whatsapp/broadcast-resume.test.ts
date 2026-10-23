import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { BroadcastError } from './broadcast-core'
import { claimBroadcastDelivery, planBroadcastResume, releaseBroadcastDelivery, RESUME_MAX_PER_REQUEST } from './broadcast-resume'

vi.mock('@/lib/whatsapp/transport/meta-adapter', () => ({
  resolveMetaTransport: vi.fn(async () => ({
    connectionId: 'conn-1',
    transport: { provider: 'meta_cloud', send: vi.fn() },
  })),
}))

interface ClaimCall { update: Record<string, unknown>; filters: Record<string, unknown>; or?: string }
function claimDb(returnedRows: unknown[], calls: ClaimCall[]): SupabaseClient {
  return { from() {
    const call: ClaimCall = { update: {}, filters: {} }
    const b: Record<string, unknown> = {
      update: (row: Record<string, unknown>) => { call.update = row; calls.push(call); return b },
      eq: (col: string, val: unknown) => { call.filters[col] = val; return b },
      or: (expr: string) => { call.or = expr; return b },
      select: async () => ({ data: returnedRows, error: null }),
      then: (resolve: (r: { error: null }) => unknown) => resolve({ error: null }),
    }
    return b
  } } as unknown as SupabaseClient
}

describe('broadcast delivery lock', () => {
  it('claims account-scoped and releases', async () => {
    const calls: ClaimCall[] = []
    expect(await claimBroadcastDelivery(claimDb([{ id: 'bc-1' }], calls), 'acct-1', 'bc-1', new Date('2026-08-11T12:00:00Z'))).toBe(true)
    expect(calls[0].filters).toEqual({ id: 'bc-1', account_id: 'acct-1' })
    expect(calls[0].or).toBe('delivery_locked_at.is.null,delivery_locked_at.lt.2026-08-11T11:30:00.000Z')

    const releaseCalls: ClaimCall[] = []
    await releaseBroadcastDelivery(claimDb([], releaseCalls), 'bc-1')
    expect(releaseCalls[0].update).toEqual({ delivery_locked_at: null })
  })
})

interface PlanFixture { broadcast?: Record<string, unknown> | null; recipients?: Record<string, unknown>[]; templates?: Record<string, unknown>[] }
interface PlanWrites { statusFilter?: unknown; failedIds?: unknown; failedUpdate?: Record<string, unknown> }
function planDb(fx: PlanFixture, writes: PlanWrites = {}): SupabaseClient {
  return { from(table: string) {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      order: () => b,
      in: (col: string, vals: unknown) => { if (col === 'status') writes.statusFilter = vals; if (col === 'id') writes.failedIds = vals; return b },
      update: (row: Record<string, unknown>) => { writes.failedUpdate = row; return b },
      maybeSingle: async () => ({ data: fx.broadcast === undefined ? null : fx.broadcast, error: null }),
      then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => {
        if (table === 'broadcast_recipients') return resolve({ data: fx.recipients ?? [], error: null })
        if (table === 'message_templates') return resolve({ data: fx.templates ?? [], error: null })
        return resolve({ data: [], error: null })
      },
    }
    return b
  } } as unknown as SupabaseClient
}

const BROADCAST = { id: 'bc-1', template_name: 'order_update', template_language: 'en_US' }
function recipient(id: string, phone: string | null, params: unknown = ['A123']) {
  return { id, template_params: params, contact: phone ? { phone } : null }
}

describe('planBroadcastResume', () => {
  it('plans outstanding recipients using provider-neutral connection identity', async () => {
    const writes: PlanWrites = {}
    const { plan, remaining, unsendable } = await planBroadcastResume(
      planDb({ broadcast: BROADCAST, recipients: [recipient('r1', '+15551234567', ['A123', 'Friday'])] }, writes),
      'acct-1', 'bc-1', 'pending',
    )
    expect(writes.statusFilter).toEqual(['pending'])
    expect(plan.accountId).toBe('acct-1')
    expect(plan.connectionId).toBe('conn-1')
    expect(plan.planned).toEqual([{ recipientRowId: 'r1', phone: '15551234567', params: ['A123', 'Friday'] }])
    expect(remaining).toBe(0)
    expect(unsendable).toBe(0)
  })

  it('fails unsendable rows up front', async () => {
    const writes: PlanWrites = {}
    const { plan, unsendable } = await planBroadcastResume(
      planDb({ broadcast: BROADCAST, recipients: [recipient('r1', '+15551234567'), recipient('r2', null), recipient('r3', 'nonsense')] }, writes),
      'acct-1', 'bc-1', 'pending',
    )
    expect(unsendable).toBe(2)
    expect(writes.failedIds).toEqual(['r2', 'r3'])
    expect(writes.failedUpdate?.status).toBe('failed')
    expect(plan.planned).toHaveLength(1)
  })

  it('caps one pass and reports leftovers', async () => {
    const many = Array.from({ length: RESUME_MAX_PER_REQUEST + 25 }, (_, i) => recipient(`r${i}`, '+1555000' + String(i).padStart(4, '0')))
    const { plan, remaining } = await planBroadcastResume(planDb({ broadcast: BROADCAST, recipients: many }), 'acct-1', 'bc-1', 'pending')
    expect(plan.planned).toHaveLength(RESUME_MAX_PER_REQUEST)
    expect(remaining).toBe(25)
  })

  it('404s a broadcast outside the account', async () => {
    await expect(planBroadcastResume(planDb({ broadcast: null }), 'acct-1', 'bc-1', 'pending')).rejects.toMatchObject({ status: 404 })
  })

  it('refuses when there is nothing outstanding', async () => {
    await expect(planBroadcastResume(planDb({ broadcast: BROADCAST, recipients: [] }), 'acct-1', 'bc-1', 'failed')).rejects.toBeInstanceOf(BroadcastError)
  })
})
