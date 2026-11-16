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
  normalizedContacts?: Array<{ id: string }>
  legacyContacts?: Array<{ id: string }>
  conversations?: Array<{ id: string }>
  inbound?: Array<{ conversation_id: string; provider_chat_id: string | null }>
  rejectTable?: string
  samePhoneIdentity?: string
  historicalInbound?: Array<{ provider_chat_id: string }>
  selectedInbound?: Array<{ conversation_id: string; provider_chat_id: string }>
  currentScoped?: Array<{ id: string }>
} = {}) {
  const reads: Array<{ table: string; filters: Record<string, unknown> }> = []
  const db = {
    from: vi.fn((table: string) => {
      const filters: Record<string, unknown> = {}
      const builder = {
        select: (_value: string) => builder,
        eq: (key: string, value: unknown) => { filters[key] = value; return builder },
        in: (key: string, value: unknown) => { filters[key] = value; return builder },
        is: (key: string, value: unknown) => { filters[key] = value; return builder },
        maybeSingle: async () => {
          reads.push({ table, filters: { ...filters } })
          return { data: table === 'whatsapp_connections' && input.samePhoneIdentity
            ? { phone_identity: input.samePhoneIdentity } : null, error: null }
        },
        order: () => builder,
        limit: () => builder,
        then: (callback: (data: unknown) => unknown) => {
          reads.push({ table, filters: { ...filters } })
          const data = table === 'contacts' ? (
            'phone_normalized' in filters
              ? (input.normalizedContacts ?? input.contacts ?? [{ id: 'contact-1' }])
              : (input.legacyContacts ?? input.contacts ?? [{ id: 'contact-1' }]))
            : table === 'conversations' ? (
                input.inbound?.length === 0 && input.currentScoped && 'id' in filters
                  ? input.currentScoped
                  : input.conversations ?? [{ id: CHAT }]
              )
              : table === 'messages' ? (
                input.inbound?.length === 0 && input.historicalInbound
                  ? Array.isArray(filters.provider_chat_id)
                    ? input.selectedInbound ?? []
                    : Array.isArray(filters.connection_id)
                      ? input.historicalInbound
                      : []
                  : input.inbound ?? [{ conversation_id: CHAT, provider_chat_id: LID }]
              ) : table === 'whatsapp_connections' ? [{id:CONNECTION},{id:'previous-session'}] : []
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
      { table: 'contacts', filters: { account_id: ACCOUNT, phone_normalized: PHONE } },
      { table: 'contacts', filters: { account_id: ACCOUNT, phone: [PHONE, `+${PHONE}`] } },
      { table: 'conversations', filters: { account_id: ACCOUNT, contact_id: 'contact-1' } },
      { table: 'messages', filters: { conversation_id: [CHAT], connection_id: CONNECTION, provider: 'openwa', sender_type: 'customer' } },
    ])
  })
  it('finds the native chat for a formatted CRM phone stored by normalized identity', async () => {
    const { db, reads } = fakeDb({normalizedContacts:[{id:'contact-1'}],legacyContacts:[]})
    expect(await resolveOpenWAPilotRecipientForGrant(db, ACCOUNT, CONNECTION, PHONE))
      .toEqual({recipient:LID, source:'verified_inbound_chat'})
    expect(reads.some(r=>r.table==='contacts' && r.filters.phone_normalized===PHONE)).toBe(true)
  })

  it('rejects different contacts matching normalized and legacy representations', async () => {
    const { db } = fakeDb({
      normalizedContacts:[{id:'contact-1'}],
      legacyContacts:[{id:'contact-2'}],
    })
    await expect(resolveOpenWAPilotRecipientForGrant(db, ACCOUNT, CONNECTION, PHONE))
      .rejects.toMatchObject({code:'connection_restricted'})
  })

  it('preserves the explicit verified @lid without converting its digits to a phone number', async () => {
    const { db, reads } = fakeDb()
    expect(await resolveOpenWAPilotRecipientForGrant(db, ACCOUNT, CONNECTION, LID))
      .toEqual({ recipient: LID, source: 'direct_recipient' })
    expect(reads).toEqual([])
  })
  it('uses phone @c.us only when no native inbound on this session or same-phone history matches', async () => {
    const { db } = fakeDb({ inbound: [] })
    expect(await resolveOpenWAPilotRecipientForGrant(db, ACCOUNT, CONNECTION, PHONE))
      .toEqual({ recipient: `${PHONE}@c.us`, source: 'phone_without_inbound' })
  })
  it('recovers a previously verified phone contact native LID on a newly linked same-phone session', async () => {
    const { db, reads } = fakeDb({
      inbound: [],
      samePhoneIdentity: 'same-own-number',
      historicalInbound: [{ provider_chat_id: LID }],
      selectedInbound: [{ conversation_id: 'new-incorrect-contact-thread', provider_chat_id: LID }],
      currentScoped: [{ id: 'new-incorrect-contact-thread' }],
    })
    expect(await resolveOpenWAPilotRecipientForGrant(db, ACCOUNT, CONNECTION, PHONE))
      .toEqual({ recipient: LID, source: 'verified_inbound_chat' })
    expect(reads).toContainEqual({table:'whatsapp_connections',filters:{
      account_id: ACCOUNT, provider: 'openwa', phone_identity:'same-own-number',
    }})
    expect(reads.some(r=>r.table==='messages' && r.filters.connection_id===CONNECTION)).toBe(true)
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
