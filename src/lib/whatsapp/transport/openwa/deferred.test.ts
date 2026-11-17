import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { WhatsAppTransportError } from '../types'

const h = vi.hoisted(() => ({ identity: vi.fn(), hydrate: vi.fn() }))
vi.mock('./contact-identity', () => ({ resolveOpenWAInboundContactIdentity: h.identity }))
vi.mock('./sender-phone', () => ({ hydrateOpenWAInboundSenderPhone: h.hydrate }))

import {
  compactOpenWAInbound, deferOpenWAWebhook, isUnresolvedOpenWALidCandidate,
  preflightOpenWAInboundIdentity, readDeferredInbound, readDeferredStatus,
} from './deferred'
import type { NormalizedInbound } from '@/lib/whatsapp/inbound-normalization'

const lid = '123456789012345@lid'
function native(): NormalizedInbound {
  return {
    message: {
      id: 'm1', provider: 'openwa', connectionId: 'conn',
      providerMessageId: 'm1', from: lid, providerChatId: lid,
      timestamp: '1792950000', type: 'text', text: { body: 'New phone' },
      providerMetadata: { secret: 'must-not-persist' },
    },
    contact: { wa_id: lid, profile: { name: 'Unknown' } },
  }
}
const context = { accountId: 'acct', connectionId: 'conn', sessionId: 'sess' }
const db = {} as SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
  h.hydrate.mockResolvedValue(false)
  h.identity.mockRejectedValue(new WhatsAppTransportError('connection_restricted', 'no verified phone'))
})

describe('durable OpenWA native identity preflight', () => {
  it('defers a native LID only when sender and chat are consistent', async () => {
    expect(isUnresolvedOpenWALidCandidate(native().message)).toBe(true)
    expect(await preflightOpenWAInboundIdentity(db, { ...context, inbound: native() })).toBe('unresolved')
    expect(h.identity).toHaveBeenCalledWith(db, expect.objectContaining({ accountId: 'acct', providerChatId: lid }))
  })
  it('does not defer an invalid/mismatched JID despite connection_restricted', async () => {
    const row = native()
    row.message.from = '999999999@c.us'
    expect(isUnresolvedOpenWALidCandidate(row.message)).toBe(false)
    await expect(preflightOpenWAInboundIdentity(db, { ...context, inbound: row }))
      .rejects.toMatchObject({ code: 'connection_restricted' })
  })
  it('accepts an authoritative phone and invokes the shared contact identity verifier', async () => {
    h.hydrate.mockImplementationOnce(async (_db: unknown, input: { inbound: NormalizedInbound }) => {
      input.inbound.message.from = '967700000001'
      input.inbound.contact.wa_id = '967700000001'
      return true
    })
    h.identity.mockResolvedValue({ phone: '967700000001', contactId: null, source: 'sender_phone' })
    const inbound = native()
    expect(await preflightOpenWAInboundIdentity(db, { ...context, inbound })).toBe('ready')
    expect(inbound.message.from).toBe('967700000001')
  })
  it('permits a same-account historical mapping while a gateway lookup is temporarily unavailable', async () => {
    h.hydrate.mockRejectedValueOnce(new WhatsAppTransportError('retryable_provider_failure', 'gateway down'))
    h.identity.mockResolvedValue({ phone: '967700000001', contactId: 'saved', source: 'historical_native_lid' })
    expect(await preflightOpenWAInboundIdentity(db, { ...context, inbound: native() })).toBe('ready')
  })
  it('does not hide an authentication/configuration failure as unresolved', async () => {
    h.hydrate.mockRejectedValueOnce(new WhatsAppTransportError('authentication_or_configuration', 'invalid credential'))
    await expect(preflightOpenWAInboundIdentity(db, { ...context, inbound: native() }))
      .rejects.toMatchObject({ code: 'authentication_or_configuration' })
  })
  it('persists only compact normalized fields, excluding provider metadata and raw base64', () => {
    const row = native()
    row.message.image = { id: 'img', mime_type: 'image/jpeg' }
    const compact = compactOpenWAInbound(row)
    expect(JSON.stringify(compact)).not.toContain('must-not-persist')
    expect(compact.message.image).toEqual({ id: 'img', mime_type: 'image/jpeg' })
    expect(readDeferredInbound(compact, 'conn', 'm1', lid)?.message.from).toBe(lid)
    expect(readDeferredInbound(compact, 'wrong-tenant', 'm1', lid)).toBeNull()
  })
  it('writes through a single transactional RPC and cannot acknowledge failed storage', async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: '23514' } })
    const client = { rpc } as unknown as SupabaseClient
    const input = {
      ...context, providerEventId: 'evt', providerMessageId: 'm1', processingToken: 'lease',
      deferred: { kind: 'unresolved_identity' as const, inbound: native() },
    }
    await expect(deferOpenWAWebhook(client, input)).resolves.toBeUndefined()
    expect(rpc).toHaveBeenCalledWith('defer_openwa_webhook_event', expect.objectContaining({
      p_account_id: 'acct', p_connection_id: 'conn', p_native_chat_id: lid,
      p_event_kind: 'unresolved_identity', p_processing_token: 'lease',
    }))
    await expect(deferOpenWAWebhook(client, input)).rejects.toThrow('durable')
  })
  it('rejects invalid deferred status vocabulary and accepts only native statuses', () => {
    expect(readDeferredStatus({ status: 'read', timestamp: '1792950000' })).toEqual({ status: 'read', timestamp: '1792950000' })
    expect(readDeferredStatus({ status: 'pending' })).toBeNull()
  })
})
