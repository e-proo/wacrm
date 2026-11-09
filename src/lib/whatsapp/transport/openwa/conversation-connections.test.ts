import { describe, expect, it, vi } from 'vitest'
import {
  authorizeConversationOpenWASendConnection,
  listConversationOpenWASendConnections,
} from './conversation-connections'

function fixture(input: { current?: { provider: string; connection_id: string } | null; phone?: string | null } = {}) {
  const predicates: { table: string; column: string; value: unknown }[] = []
  const current = input.current === undefined ? { provider: 'openwa', connection_id: 'old-connection' } : input.current
  const phone = input.phone === undefined ? '967700000000' : input.phone
  const db = {
    from: vi.fn((table: string) => {
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn((column: string, value: unknown) => {
          predicates.push({ table, column, value })
          return query
        }),
        in: vi.fn(() => query),
        not: vi.fn(() => query),
        order: vi.fn(() => query),
        limit: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({
          data: table === 'conversations' ? { id: 'conversation' }
            : table === 'messages' ? current
              : table === 'whatsapp_connections' ? { id: 'old-connection', phone_identity: phone }
                : null,
          error: null,
        })),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve({
            data: table === 'whatsapp_connections'
              ? [
                  { id: 'old-connection', display_name: 'Old', status: 'ready', session_id: 'old-session', phone_identity: phone },
                  { id: 'new-connection', display_name: 'New', status: 'ready', session_id: 'new-session', phone_identity: phone },
                  { id: 'wrong-phone', display_name: 'Wrong', status: 'ready', session_id: 'bad-session', phone_identity: 'not-the-same-phone' },
                ]
              : table === 'whatsapp_connection_credentials'
                ? [
                    { connection_id: 'old-connection', base_url: 'https://old.trycloudflare.com' },
                    { connection_id: 'new-connection', base_url: 'https://current.trycloudflare.com' },
                    { connection_id: 'wrong-phone', base_url: 'https://unrelated.trycloudflare.com' },
                  ]
                : [],
            error: null,
          }).then(resolve, reject),
      }
      return query
    }),
  }
  return { db, predicates }
}

describe('OpenWA conversation connection selection', () => {
  it('lists only same-account, same-phone active sessions with nonsecret gateway hosts', async () => {
    const { db, predicates } = fixture()
    const result = await listConversationOpenWASendConnections(db as never, 'acct-1', 'conversation-1')
    expect(result.current_connection_id).toBe('old-connection')
    expect(result.options).toEqual([
      { id: 'old-connection', display_name: 'Old', status: 'ready', gateway_host: 'old.trycloudflare.com' },
      { id: 'new-connection', display_name: 'New', status: 'ready', gateway_host: 'current.trycloudflare.com' },
    ])
    const accountScoped = predicates.filter((row) =>
      row.table === 'conversations' || row.table === 'whatsapp_connections' || row.table === 'whatsapp_connection_credentials')
    expect(accountScoped.every((row) => row.column === 'account_id' || row.column === 'id' || row.column === 'provider' || row.column === 'phone_identity')).toBe(true)
    expect(accountScoped.filter((row) => row.column === 'account_id')).toHaveLength(3)
    expect(accountScoped.filter((row) => row.column === 'account_id').every((row) => row.value === 'acct-1')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('session_id')
    expect(JSON.stringify(result)).not.toContain('api_key')
  })

  it('authorizes a human-selected matching session, rejecting a foreign or mismatched one', async () => {
    const { db } = fixture()
    await expect(authorizeConversationOpenWASendConnection(db as never, 'acct-1', 'conversation-1', 'new-connection')).resolves.toBeUndefined()
    await expect(authorizeConversationOpenWASendConnection(db as never, 'acct-1', 'conversation-1', 'wrong-phone')).rejects.toMatchObject({ code: 'connection_restricted' })
    await expect(authorizeConversationOpenWASendConnection(db as never, 'acct-1', 'conversation-1', 'foreign-tenant')).rejects.toMatchObject({ code: 'connection_restricted' })
  })

  it('never allows a WhatsApp connection switch from a Meta conversation or unknown phone identity', async () => {
    const meta = fixture({ current: { provider: 'meta_cloud', connection_id: 'meta-id' } })
    await expect(authorizeConversationOpenWASendConnection(meta.db as never, 'acct-1', 'conversation-1', 'new-connection')).rejects.toMatchObject({ code: 'connection_restricted' })
    const noPhone = fixture({ phone: null })
    await expect(authorizeConversationOpenWASendConnection(noPhone.db as never, 'acct-1', 'conversation-1', 'new-connection')).rejects.toMatchObject({ code: 'connection_restricted' })
  })
})
