import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { isOpenWAOneToOneChatId, resolveOpenWAConversationRecipient } from './recipient'

function fixture(options: { account?: string; inbound?: { provider_chat_id: unknown } | null; error?: { code: string } } = {}) {
  const queries: Record<string, Array<[string, unknown]>> = { conversations: [], messages: [] }
  const from = vi.fn((table: string) => {
    const filters: Record<string, unknown> = {}
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((key: string, value: unknown) => {
        queries[table].push([key, value])
        filters[key] = value
        return query
      }),
      order: vi.fn(() => query),
      limit: vi.fn(() => query),
      maybeSingle: vi.fn(async () => {
        if (table === 'conversations') {
          return { data: filters.account_id === (options.account ?? 'acct-1') ? { id: filters.id } : null, error: null }
        }
        return { data: options.inbound === undefined ? { provider_chat_id: '63256345444412@lid' } : options.inbound, error: options.error ?? null }
      }),
    }
    return query
  })
  return { db: { from } as unknown as SupabaseClient, from, queries }
}
const input = { accountId: 'acct-1', conversationId: 'conv-1', connectionId: 'conn-1', fallbackPhone: '967700000001' }

describe('account- and connection-scoped OpenWA chat recipient', () => {
  it('routes inbound LID replies to their exact chat, not the digits treated as a phone', async () => {
    const { db, queries } = fixture()
    await expect(resolveOpenWAConversationRecipient(db, input)).resolves.toBe('63256345444412@lid')
    expect(queries.conversations).toContainEqual(['account_id', 'acct-1'])
    expect(queries.messages).toEqual(expect.arrayContaining([
      ['conversation_id', 'conv-1'], ['provider', 'openwa'],
      ['connection_id', 'conn-1'], ['sender_type', 'customer'],
    ]))
  })

  it('preserves a legitimate phone JID from an inbound message', async () => {
    const { db } = fixture({ inbound: { provider_chat_id: '967700000001@c.us' } })
    await expect(resolveOpenWAConversationRecipient(db, input)).resolves.toBe('967700000001@c.us')
  })

  it.each([null, { provider_chat_id: null }, { provider_chat_id: '120363123456@g.us' }, { provider_chat_id: '63256345444412@lid@c.us' }])(
    'blocks an inbound row with missing or unsafe chat destination: %j', async (inbound) => {
      const { db } = fixture({ inbound: inbound as { provider_chat_id: unknown } | null })
      // A null row means no inbound exists, so only non-null invalid rows are blocked.
      if (inbound === null) {
        await expect(resolveOpenWAConversationRecipient(db, input)).resolves.toBe(input.fallbackPhone)
      } else {
        await expect(resolveOpenWAConversationRecipient(db, input)).rejects.toMatchObject({ code: 'connection_restricted' })
      }
    },
  )

  it('does not use a recipient or connection outside the current account', async () => {
    const { db, from } = fixture({ account: 'other-account' })
    await expect(resolveOpenWAConversationRecipient(db, input)).rejects.toMatchObject({ code: 'authentication_or_configuration' })
    expect(from).toHaveBeenCalledTimes(1)
  })

  it('never falls back to a guessed phone if the scoped inbound lookup fails', async () => {
    const { db } = fixture({ error: { code: 'PGRST205' } })
    await expect(resolveOpenWAConversationRecipient(db, input)).rejects.toMatchObject({ code: 'retryable_provider_failure' })
  })

  it('accepts only strict one-to-one provider chat IDs', () => {
    expect(isOpenWAOneToOneChatId('63256345444412@lid')).toBe(true)
    expect(isOpenWAOneToOneChatId('967700000001@c.us')).toBe(true)
    expect(isOpenWAOneToOneChatId('63256345444412@g.us')).toBe(false)
    expect(isOpenWAOneToOneChatId('63256345444412@lid@c.us')).toBe(false)
    expect(isOpenWAOneToOneChatId('')).toBe(false)
  })
})
