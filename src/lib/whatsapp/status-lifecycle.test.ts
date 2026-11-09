import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { applyWhatsAppStatus, applyOpenWAStatusWithRetry, isForwardStatusTransition, normalizeMetaStatus, normalizeOpenWAStatus, parseOpenWAStatusEvent } from './status-lifecycle'

function db(message: Record<string, unknown> | null, recipient: Record<string, unknown> | null = null, connection: Record<string, unknown> | null = { id: 'conn' }) {
  const updates: Array<{ table: string; value: unknown }> = []
  const client = { from(table: string) { const b: Record<string, unknown> = { select: () => b, update: (value: unknown) => { updates.push({ table, value }); return b }, eq: () => b, maybeSingle: async () => ({ data: table === 'whatsapp_connections' ? connection : table === 'messages' ? message : recipient, error: null }), then: (resolve: (v: unknown) => void) => resolve({ error: null }) }; return b } } as unknown as SupabaseClient
  return { client, updates }
}

describe('provider-neutral status lifecycle', () => {
  it.each([['server_ack','sent'],['device-ack','delivered'],['read','read'],['error','failed']])('normalizes OpenWA %s to %s', (raw, expected) => expect(normalizeOpenWAStatus(raw)).toBe(expected))
  it.each([['sent','sent'],['delivered','delivered'],['read','read'],['failed','failed']])('normalizes Meta %s to %s', (raw, expected) => expect(normalizeMetaStatus(raw)).toBe(expected))
  it('ignores unknown provider vocabulary', () => { expect(normalizeOpenWAStatus('mystery')).toBeNull(); expect(normalizeMetaStatus('mystery')).toBeNull() })
  it('enforces forward-only lifecycle and terminal failure semantics', () => { expect(isForwardStatusTransition('pending','sent')).toBe(true); expect(isForwardStatusTransition('pending','failed')).toBe(true); expect(isForwardStatusTransition('sending','sent')).toBe(true); expect(isForwardStatusTransition('sending','failed')).toBe(true); expect(isForwardStatusTransition('sent','delivered')).toBe(true); expect(isForwardStatusTransition('delivered','sent')).toBe(false); expect(isForwardStatusTransition('read','failed')).toBe(false); expect(isForwardStatusTransition('failed','read')).toBe(false) })
  it.each([
    [1, 'sent'], [2, 'delivered'], [3, 'read'], [4, 'read'],
    ['2', 'delivered'], [-1, 'failed'],
  ])('parses WhatsApp numeric ACK %s as %s', (ack, status) => {
    expect(parseOpenWAStatusEvent({ messageId: 'native-media-1', ack })?.status).toBe(status)
  })
  it('parses an ACK wrapped in a provider message with native message identity', () => {
    expect(parseOpenWAStatusEvent({
      message: { id: 'native-video-1', ack: 3 }, timestamp: 1792950000,
    })).toMatchObject({ providerMessageId: 'native-video-1', status: 'read' })
  })
  it('rejects unrecognized ACK values rather than guessing delivery', () => {
    expect(parseOpenWAStatusEvent({ messageId: 'm', ack: 0 })).toBeNull()
    expect(parseOpenWAStatusEvent({ messageId: 'm', ack: 99 })).toBeNull()
  })
  it('parses bounded diagnostics without secrets', () => { const parsed = parseOpenWAStatusEvent({ messageId: 'm1', status: 'failed', error: 'token=secret-value provider rejected' }); expect(parsed).toMatchObject({ providerMessageId: 'm1', status: 'failed' }); expect(parsed?.diagnostic).not.toContain('secret-value') })
  it('updates message and broadcast recipient only through provider+connection identity', async () => { const mock = db({ id: 'row1', conversation_id: 'c', status: 'sent' }, { id: 'r1', status: 'sent' }); await expect(applyWhatsAppStatus(mock.client, { provider: 'openwa', accountId: 'acct', connectionId: 'conn', providerMessageId: 'ow1', status: 'delivered', timestamp: '1792950000' })).resolves.toBe('updated'); expect(mock.updates).toEqual(expect.arrayContaining([{ table: 'messages', value: { status: 'delivered' } }, { table: 'broadcast_recipients', value: expect.objectContaining({ status: 'delivered' }) }])) })
  it('updates a broadcast recipient even when no inbox message row exists', async () => { const mock = db(null, { id: 'r1', status: 'sent' }); await expect(applyWhatsAppStatus(mock.client, { provider: 'meta_cloud', accountId: 'acct', connectionId: 'conn', providerMessageId: 'wamid-1', status: 'delivered', timestamp: '1792950000' })).resolves.toBe('updated'); expect(mock.updates).toEqual([{ table: 'broadcast_recipients', value: expect.objectContaining({ status: 'delivered' }) }]) })
  it('rechecks a fast ACK until the outbound provider ID is persisted, without sending anything', async () => {
    let messageExists = false
    const updates: Array<{ table: string; value: unknown }> = []
    const client = { from(table: string) {
      const q: Record<string, unknown> = {
        select: () => q, eq: () => q,
        update: (value: unknown) => { updates.push({ table, value }); return q },
        maybeSingle: async () => ({ data: table === 'whatsapp_connections' ? { id: 'conn' } : table === 'messages' && messageExists ? { id: 'msg', status: 'sent' } : null, error: null }),
        then: (resolve: (value: unknown) => void) => resolve({ error: null }),
      }
      return q
    } } as unknown as SupabaseClient
    const waits: number[] = []
    const result = await applyOpenWAStatusWithRetry(client, {
      provider: 'openwa', accountId: 'acct', connectionId: 'conn',
      providerMessageId: 'media-1', status: 'read',
    }, async (ms) => { waits.push(ms); messageExists = true })
    expect(result).toBe('updated')
    expect(waits).toEqual([250])
    expect(updates).toEqual([{ table: 'messages', value: { status: 'read' } }])
  })
  it('bounds unmatched ACK retries and does not mutate unrelated messages', async () => {
    const mock = db(null)
    const waits: number[] = []
    await expect(applyOpenWAStatusWithRetry(mock.client, {
      provider: 'openwa', accountId: 'acct', connectionId: 'conn',
      providerMessageId: 'unmatched', status: 'read',
    }, async (ms) => { waits.push(ms) })).resolves.toBe('unknown')
    expect(waits).toEqual([250, 750, 1500, 3000, 5000])
    expect(mock.updates).toHaveLength(0)
  })
  it('returns unknown without writing for an unknown provider message', async () => { const mock = db(null); await expect(applyWhatsAppStatus(mock.client, { provider: 'openwa', accountId: 'acct', connectionId: 'conn', providerMessageId: 'missing', status: 'read' })).resolves.toBe('unknown'); expect(mock.updates).toHaveLength(0) })
  it('rejects a wrong tenant/connection before any message write', async () => { const mock = db({ id: 'row1', status: 'sent' }, null, null); await expect(applyWhatsAppStatus(mock.client, { provider: 'openwa', accountId: 'other', connectionId: 'conn', providerMessageId: 'ow1', status: 'delivered' })).resolves.toBe('unknown'); expect(mock.updates).toHaveLength(0) })
  it('ignores duplicate/backward transitions without writes', async () => { const mock = db({ id: 'row1', conversation_id: 'c', status: 'read' }); await expect(applyWhatsAppStatus(mock.client, { provider: 'openwa', accountId: 'acct', connectionId: 'conn', providerMessageId: 'ow1', status: 'delivered' })).resolves.toBe('ignored'); expect(mock.updates).toHaveLength(0) })
})
