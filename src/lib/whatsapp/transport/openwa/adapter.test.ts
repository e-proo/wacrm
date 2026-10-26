import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { resolveOpenWATransport } from './adapter'
import { resolveOpenWAClient } from './credentials'

vi.mock('./credentials', () => ({ resolveOpenWAClient: vi.fn() }))

function connectionDb(row: Record<string, unknown> | null): SupabaseClient {
  return { from() {
    const b: Record<string, unknown> = {
      select: () => b, eq: () => b,
      maybeSingle: async () => ({ data: row, error: null }),
    }
    return b
  } } as unknown as SupabaseClient
}

describe('OpenWA outbound adapter', () => {
  it('sends text/reply with stable idempotency identity and normalizes provider id', async () => {
    const sendText = vi.fn(async () => ({ providerMessageId: 'ow-msg-1', raw: { engine: 'baileys' } }))
    vi.mocked(resolveOpenWAClient).mockResolvedValue({ credentials: {} as never, client: { sendText } as never })
    const resolved = await resolveOpenWATransport(connectionDb({ id: 'conn-1', account_id: 'acct-1', provider: 'openwa', status: 'ready', session_id: 'sess-1' }), 'acct-1', 'conn-1')
    const result = await resolved.transport.send({
      accountId: 'acct-1', connectionId: 'conn-1', recipient: '15551234567',
      content: { kind: 'text', text: 'hello' }, replyToProviderMessageId: 'ow-parent', idempotencyKey: 'send-1',
    })
    expect(sendText).toHaveBeenCalledWith({ sessionId: 'sess-1', to: '15551234567', text: 'hello', replyToProviderMessageId: 'ow-parent', idempotencyKey: 'send-1' }, 'send-1')
    expect(result).toMatchObject({ provider: 'openwa', connectionId: 'conn-1', providerMessageId: 'ow-msg-1' })
  })

  it('fails closed for disconnected connections', async () => {
    await expect(resolveOpenWATransport(connectionDb({ id: 'conn-1', account_id: 'acct-1', provider: 'openwa', status: 'disconnected', session_id: 'sess-1' }), 'acct-1', 'conn-1')).rejects.toMatchObject({ code: 'connection_restricted' })
  })

  it('rejects non-text capability and missing idempotency key', async () => {
    vi.mocked(resolveOpenWAClient).mockResolvedValue({ credentials: {} as never, client: { sendText: vi.fn() } as never })
    const resolved = await resolveOpenWATransport(connectionDb({ id: 'conn-1', account_id: 'acct-1', provider: 'openwa', status: 'connected', session_id: 'sess-1' }), 'acct-1', 'conn-1')
    await expect(resolved.transport.send({ accountId: 'acct-1', connectionId: 'conn-1', recipient: '1', content: { kind: 'template', templateName: 'x', language: 'en' }, idempotencyKey: 'k' })).rejects.toMatchObject({ code: 'unsupported_capability' })
    await expect(resolved.transport.send({ accountId: 'acct-1', connectionId: 'conn-1', recipient: '1', content: { kind: 'text', text: 'x' } })).rejects.toMatchObject({ code: 'invalid_request' })
  })
})
