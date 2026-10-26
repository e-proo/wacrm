import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { applyWhatsAppStatus, isForwardStatusTransition, normalizeMetaStatus, normalizeOpenWAStatus, parseOpenWAStatusEvent } from './status-lifecycle'

function db(message: Record<string, unknown> | null, recipient: Record<string, unknown> | null = null, connection: Record<string, unknown> | null = { id: 'conn' }) {
  const updates: Array<{ table: string; value: unknown }> = []
  const client = { from(table: string) { const b: Record<string, unknown> = { select: () => b, update: (value: unknown) => { updates.push({ table, value }); return b }, eq: () => b, maybeSingle: async () => ({ data: table === 'whatsapp_connections' ? connection : table === 'messages' ? message : recipient, error: null }), then: (resolve: (v: unknown) => void) => resolve({ error: null }) }; return b } } as unknown as SupabaseClient
  return { client, updates }
}

describe('provider-neutral status lifecycle', () => {
  it.each([['server_ack','sent'],['device-ack','delivered'],['read','read'],['error','failed']])('normalizes OpenWA %s to %s', (raw, expected) => expect(normalizeOpenWAStatus(raw)).toBe(expected))
  it.each([['sent','sent'],['delivered','delivered'],['read','read'],['failed','failed']])('normalizes Meta %s to %s', (raw, expected) => expect(normalizeMetaStatus(raw)).toBe(expected))
  it('ignores unknown provider vocabulary', () => { expect(normalizeOpenWAStatus('mystery')).toBeNull(); expect(normalizeMetaStatus('mystery')).toBeNull() })
  it('enforces forward-only lifecycle and terminal failure semantics', () => { expect(isForwardStatusTransition('sent','delivered')).toBe(true); expect(isForwardStatusTransition('delivered','sent')).toBe(false); expect(isForwardStatusTransition('read','failed')).toBe(false); expect(isForwardStatusTransition('failed','read')).toBe(false) })
  it('parses bounded diagnostics without secrets', () => { const parsed = parseOpenWAStatusEvent({ messageId: 'm1', status: 'failed', error: 'token=secret-value provider rejected' }); expect(parsed).toMatchObject({ providerMessageId: 'm1', status: 'failed' }); expect(parsed?.diagnostic).not.toContain('secret-value') })
  it('updates message and broadcast recipient only through provider+connection identity', async () => { const mock = db({ id: 'row1', conversation_id: 'c', status: 'sent' }, { id: 'r1', status: 'sent' }); await expect(applyWhatsAppStatus(mock.client, { provider: 'openwa', accountId: 'acct', connectionId: 'conn', providerMessageId: 'ow1', status: 'delivered', timestamp: '1792950000' })).resolves.toBe('updated'); expect(mock.updates).toEqual(expect.arrayContaining([{ table: 'messages', value: { status: 'delivered' } }, { table: 'broadcast_recipients', value: expect.objectContaining({ status: 'delivered' }) }])) })
  it('returns unknown without writing for an unknown provider message', async () => { const mock = db(null); await expect(applyWhatsAppStatus(mock.client, { provider: 'openwa', accountId: 'acct', connectionId: 'conn', providerMessageId: 'missing', status: 'read' })).resolves.toBe('unknown'); expect(mock.updates).toHaveLength(0) })
  it('rejects a wrong tenant/connection before any message write', async () => { const mock = db({ id: 'row1', status: 'sent' }, null, null); await expect(applyWhatsAppStatus(mock.client, { provider: 'openwa', accountId: 'other', connectionId: 'conn', providerMessageId: 'ow1', status: 'delivered' })).resolves.toBe('unknown'); expect(mock.updates).toHaveLength(0) })
  it('ignores duplicate/backward transitions without writes', async () => { const mock = db({ id: 'row1', conversation_id: 'c', status: 'read' }); await expect(applyWhatsAppStatus(mock.client, { provider: 'openwa', accountId: 'acct', connectionId: 'conn', providerMessageId: 'ow1', status: 'delivered' })).resolves.toBe('ignored'); expect(mock.updates).toHaveLength(0) })
})
