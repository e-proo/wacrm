import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveOpenWAPilotRecipientForGrant } from './pilot-recipient'

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CONNECTION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PHONE = '967773000299'
const LID = '123456789012345@lid'
const CHAT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function fakeDb(input: {
  contacts?: Array<{ id: string }>
  conversations?: Array<{ id: string }>
  inbound?: Array<{ conversation_id: string; provider_chat_id: string | null }>
  rejectTable?: string
} = {}) {
  const reads: Array<{ table: string; filters: Record<string, unknown> }> = []
  const db = {
    from: vi.fn((table: string) => {
      const filters: Record<string, unknown> = {}
      const builder = {
        select: (_value: string) => builder,
        eq: (key: string, value: unknown) => { filters[key] = value; return builder },
        in: (key: string, value: unknown) => { filters[key] = value; return builder },
        order: () => builder,
        limit: () => builder,
        then: (callback: (data: unknown) => unknown) => {
          reads.push({ table, filters: { ...filters } })
          const data = table === 'contacts' ? (input.contacts ?? [{ id: 'contact-1' }])
            : table === 'conversations' ? (input.conversations ?? [{ id: CHAT }])
              : table === 'messages' ? (input.inbound ?? [{ conversation_id: CHAT, provider_chat_id: LID }]) : []
          return Promise.resolve(callback(input.rejectTable === table
            ? { data: null, error: { code: 'XX001' } }
            : { data, error: null }))
        },
      }
      return builder
    }),
  } as unknown as SupabaseClient
  return { db, reads }
}

describe('OpenWA Pilot resolves consent to the same native chat as inbox send', () => {
  it('binds a typed test phone to its verified signed inbound LID on selected session', async () => {
    const { db, reads } = fakeDb()
    const result = await resolveOpenWAPilotRecipientForGrant(db, ACCOUNT, CONNECTION, PHONE)
    expect(result).toEqual({ recipient: LID, source: 'verified_inbound_chat' })
    expect(reads).toEqual([
      { table: 'contacts', filters: { account_id: ACCOUNT, phone: [PHONE, `+${PHONE}`] } },
      { table: 'conversations', filters: { account_id: ACCOUNT, contact_id: 'contact-1' } },
      { table: 'messages', filters: { conversation_id: [CHAT], connection_id: CONNECTION, provider: 'openwa', sender_type: 'customer' } },
    ])
  })
  it('preserves the explicit verified @lid without converting its digits to a phone number', async () => {
    const { db, reads } = fakeDb()
    expect(await resolveOpenWAPilotRecipientForGrant(db, ACCOUNT, CONNECTION, LID))
      .toEqual({ recipient: LID, source: 'direct_recipient' })
    expect(reads).toEqual([])
  })
  it('uses phone @c.us only for a contact with no inbound chat on this connection', async () => {
    const { db } = fakeDb({ inbound: [] })
    expect(await resolveOpenWAPilotRecipientForGrant(db, ACCOUNT, CONNECTION, PHONE))
      .toEqual({ recipient: `${PHONE}@c.us`, source: 'phone_without_inbound' })
  })
  it('fails closed for ambiguous duplicate contacts or multiple native chats', async () => {
    const duplicate = fakeDb({ contacts: [{ id: 'contact-1' }, { id: 'contact-2' }] })
    await expect(resolveOpenWAPilotRecipientForGrant(duplicate.db, ACCOUNT, CONNECTION, PHONE))
      .rejects.toMatchObject({ code: 'connection_restricted' })
    const inconsistent = fakeDb({ inbound: [
      { conversation_id: CHAT, provider_chat_id: LID },
      { conversation_id: CHAT, provider_chat_id: `${PHONE}@c.us` },
    ] })
    await expect(resolveOpenWAPilotRecipientForGrant(inconsistent.db, ACCOUNT, CONNECTION, PHONE))
      .rejects.toMatchObject({ code: 'connection_restricted' })
  })
  it('refuses a missing native chat identifier rather than silently approving a phone', async () => {
    const { db } = fakeDb({ inbound: [{ conversation_id: CHAT, provider_chat_id: null }] })
    await expect(resolveOpenWAPilotRecipientForGrant(db, ACCOUNT, CONNECTION, PHONE))
      .rejects.toMatchObject({ code: 'connection_restricted' })
  })
  it('fails closed on contact and conversation query errors', async () => {
    for (const rejectTable of ['contacts', 'conversations', 'messages']) {
      const { db } = fakeDb({ rejectTable })
      await expect(resolveOpenWAPilotRecipientForGrant(db, ACCOUNT, CONNECTION, PHONE))
        .rejects.toMatchObject({ code: 'retryable_provider_failure' })
    }
  })
  it('rejects malformed phones and JIDs before looking up contacts', async () => {
    const { db, reads } = fakeDb()
    await expect(resolveOpenWAPilotRecipientForGrant(db, ACCOUNT, CONNECTION, '000123'))
      .rejects.toMatchObject({ code: 'invalid_request' })
    expect(reads).toEqual([])
  })
})
