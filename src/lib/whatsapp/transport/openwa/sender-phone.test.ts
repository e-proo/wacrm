import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const mock = vi.hoisted(() => ({ resolveClient: vi.fn(), request: vi.fn() }))
vi.mock('./credentials', () => ({ resolveOpenWAClient: mock.resolveClient }))
import { hydrateOpenWAInboundSenderPhone } from './sender-phone'
import type { NormalizedInbound } from '@/lib/whatsapp/inbound-normalization'

const chat = '123456789012345@lid'
const db = {} as SupabaseClient
function inbound(from = chat): NormalizedInbound {
  return {
    message: {
      id: 'm-1', provider: 'openwa', connectionId: 'conn', providerMessageId: 'm-1',
      providerChatId: chat, from, timestamp: '1792950000', type: 'text', text: { body: 'hello' },
    },
    contact: { wa_id: from, profile: { name: 'Contact' } },
  }
}
const scope = { accountId: 'acct', connectionId: 'conn', sessionId: 'sess' }

beforeEach(() => {
  vi.clearAllMocks()
  mock.resolveClient.mockResolvedValue({ client: { request: mock.request } })
})

describe('OpenWA on-demand signed inbound sender-phone fallback', () => {
  it('resolves a new @lid via the account-scoped OpenWA contact API', async () => {
    mock.request.mockResolvedValue({ contactId: chat, phone: '967700000001' })
    const msg = inbound()
    expect(await hydrateOpenWAInboundSenderPhone(db, { ...scope, inbound: msg })).toBe(true)
    expect(msg.message.from).toBe('967700000001')
    expect(msg.contact.wa_id).toBe('967700000001')
    expect(mock.resolveClient).toHaveBeenCalledWith(db, 'acct', 'conn', { timeoutMs: 5000 })
    expect(mock.request).toHaveBeenCalledWith('/api/sessions/sess/contacts/123456789012345%40lid/phone', { timeoutMs: 5000 })
  })
  it('does not confuse a privacy id with a phone when the gateway cannot resolve it', async () => {
    for (const response of [{ phone: null }, { phone: chat.slice(0, -4) }, { phone: 'not-a-phone' }]) {
      mock.request.mockResolvedValueOnce(response)
      const msg = inbound()
      expect(await hydrateOpenWAInboundSenderPhone(db, { ...scope, inbound: msg })).toBe(false)
      expect(msg.message.from).toBe(chat)
    }
  })
  it('does not query the gateway when the signed webhook already has a distinct phone', async () => {
    const msg = inbound('967700000001')
    expect(await hydrateOpenWAInboundSenderPhone(db, { ...scope, inbound: msg })).toBe(false)
    expect(mock.resolveClient).not.toHaveBeenCalled()
  })
  it('refuses non-one-to-one or inconsistent native identities', async () => {
    const bad = inbound()
    bad.message.providerChatId = '123@g.us'
    expect(await hydrateOpenWAInboundSenderPhone(db, { ...scope, inbound: bad })).toBe(false)
    const mismatch = inbound('967700000001@c.us')
    expect(await hydrateOpenWAInboundSenderPhone(db, { ...scope, inbound: mismatch })).toBe(false)
    expect(mock.resolveClient).not.toHaveBeenCalled()
  })
  it('leaves the message untouched on a failed lookup, permitting signed retry', async () => {
    mock.request.mockRejectedValue(new Error('temporary gateway failure'))
    const msg = inbound()
    await expect(hydrateOpenWAInboundSenderPhone(db, { ...scope, inbound: msg })).rejects.toThrow('temporary gateway failure')
    expect(msg.message.from).toBe(chat)
  })
})
