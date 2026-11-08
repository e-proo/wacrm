import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { processOpenWAOwnSentEcho } from './outbound-echo'
import { findOrCreateContact, findOrCreateConversation } from '@/lib/whatsapp/inbound-processor'

vi.mock('@/lib/whatsapp/inbound-processor', () => ({
  findOrCreateContact: vi.fn(),
  findOrCreateConversation: vi.fn(),
}))
vi.mock('./inbound-media', () => ({ hydrateOpenWAInboundMessageMedia: vi.fn() }))

function fixture(opts: { existing?: boolean; lidMapping?: boolean } = {}) {
  const writes: Record<string, unknown>[] = []
  const updates: Record<string, unknown>[] = []
  const queries: Record<string, unknown>[] = []
  const db = {
    from(table: string) {
      const q: Record<string, unknown> = { table }
      q.select = () => q
      q.eq = (key: string, value: string) => { queries.push({ table, key, value }); return q }
      q.order = () => q
      q.limit = () => q
      q.maybeSingle = async () => ({
        data: table === 'messages' && opts.existing ? { id: 'native-row' }
          : table === 'messages' && opts.lidMapping ? { conversation_id: 'conv-1' }
          : table === 'conversations' ? { id: 'conv-1' } : null,
        error: null,
      })
      q.upsert = (row: Record<string, unknown>) => { writes.push(row); return q }
      q.update = (row: Record<string, unknown>) => { updates.push(row); return q }
      q.then = (resolve: (r: unknown) => unknown) => resolve({ error: null })
      return q
    },
  } as unknown as SupabaseClient
  return { db, writes, updates, queries }
}

const base = {
  storage: {} as never,
  accountId: 'acct-1',
  connectionId: 'conn-1',
  ownerUserId: 'owner-1',
  message: {
    provider: 'openwa', connectionId: 'conn-1', providerMessageId: 'native-1',
    providerChatId: '12345678901@c.us', from: '12345678901',
    type: 'text', text: { body: 'from linked phone' }, timestamp: '1792950000',
  } as never,
}

describe('OpenWA own-sent phone/API echo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(findOrCreateContact).mockResolvedValue({
      contact: { id: 'contact-1' },
      wasCreated: false,
    } as never)
    vi.mocked(findOrCreateConversation).mockResolvedValue({
      conversation: { id: 'conv-1' },
      created: false,
    } as never)
  })

  it('ignores an already persisted API-originated native message ID', async () => {
    const t = fixture({ existing: true })
    expect(await processOpenWAOwnSentEcho({ ...base, db: t.db })).toBe('existing')
    expect(findOrCreateContact).not.toHaveBeenCalled()
    expect(t.writes).toHaveLength(0)
  })

  it('persists one own-device message as agent, never a customer unread', async () => {
    const t = fixture()
    // Supabase .upsert(...).select('id') resolves with insertedRows.
    const originalFrom = t.db.from.bind(t.db)
    const db = { from(table: string) {
      const q = originalFrom(table) as unknown as Record<string, unknown>
      if (table === 'messages') {
        const originalUpsert = q.upsert as (row: Record<string, unknown>) => Record<string, unknown>
        q.upsert = (row: Record<string, unknown>) => {
          originalUpsert(row)
          return { select: async () => ({ data: [{ id: 'sent-row' }], error: null }) }
        }
      }
      return q
    } } as unknown as SupabaseClient
    expect(await processOpenWAOwnSentEcho({ ...base, db })).toBe('inserted')
    expect(t.writes).toHaveLength(1)
    expect(t.writes[0]).toMatchObject({
      sender_type: 'agent', status: 'sent', provider: 'openwa',
      provider_message_id: 'native-1', message_id: 'native-1', connection_id: 'conn-1',
    })
    expect(t.writes[0]).not.toHaveProperty('outbound_idempotency_key')
    expect(t.updates).toHaveLength(1)
    expect(t.queries).toContainEqual({ table: 'conversations', key: 'account_id', value: 'acct-1' })
  })

  it('does not turn an unmapped @lid into a fake phone contact', async () => {
    const t = fixture()
    const message = { ...(base.message as unknown as Record<string, unknown>), providerChatId: '12345678901@lid' } as never
    expect(await processOpenWAOwnSentEcho({ ...base, db: t.db, message })).toBe('ignored')
    expect(findOrCreateContact).not.toHaveBeenCalled()
    expect(t.writes).toHaveLength(0)
  })

  it('rejects provider connection mismatches without looking up contacts', async () => {
    const t = fixture()
    const message = { ...(base.message as unknown as Record<string, unknown>), connectionId: 'other-conn' } as never
    expect(await processOpenWAOwnSentEcho({ ...base, db: t.db, message })).toBe('ignored')
    expect(findOrCreateContact).not.toHaveBeenCalled()
  })
})
