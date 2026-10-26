import { describe, expect, it, vi } from 'vitest'
import { normalizeMetaInboundMessage, normalizeOpenWAInboundMessage } from './inbound-normalization'

describe('provider-neutral inbound normalization', () => {
  it('normalizes equivalent Meta and OpenWA text into equivalent business fields', () => {
    const meta = normalizeMetaInboundMessage({ id: 'm-1', from: '967700000001', timestamp: '1792950000', type: 'text', text: { body: 'hello' } }, { profile: { name: 'Customer' }, wa_id: '967700000001' }, 'meta-connection')
    const openwa = normalizeOpenWAInboundMessage({ eventId: 'evt-1', sessionId: 'session-1', event: 'message.received', data: { id: 'w-1', from: '967700000001', timestamp: '1792950000', text: 'hello', pushName: 'Customer' } }, 'openwa-connection')
    expect(openwa).not.toBeNull(); expect(openwa?.message.type).toBe(meta.message.type); expect(openwa?.message.from).toBe(meta.message.from); expect(openwa?.message.timestamp).toBe(meta.message.timestamp); expect(openwa?.message.text?.body).toBe(meta.message.text?.body); expect(openwa?.contact).toEqual(meta.contact); expect(meta.message.provider).toBe('meta_cloud'); expect(openwa?.message.provider).toBe('openwa')
  })
  it('normalizes OpenWA reply context and preserves provider identity', () => {
    const normalized = normalizeOpenWAInboundMessage({ eventId: 'evt-2', sessionId: 'session-2', instanceId: 'instance-1', event: 'message', data: { messageId: 'msg-2', sender: '15551234567', body: 'reply', replyToMessageId: 'parent-1', timestamp: 1792950000000 } }, 'connection-2')
    expect(normalized?.message).toMatchObject({ provider: 'openwa', connectionId: 'connection-2', providerMessageId: 'msg-2', from: '15551234567', timestamp: '1792950000', context: { id: 'parent-1' } })
  })
  it.each([
    ['image', { id: 'img-1', mimeType: 'image/jpeg', caption: 'photo', fileSize: 123 }],
    ['video', { mediaId: 'vid-1', mime_type: 'video/mp4', caption: 'clip' }],
    ['audio', { id: 'aud-1', mimeType: 'audio/ogg' }],
    ['document', { id: 'doc-1', mimeType: 'application/pdf', filename: 'invoice.pdf', fileSize: '456' }],
  ] as const)('normalizes OpenWA %s media descriptors without base64 persistence', (type, media) => {
    const normalized = normalizeOpenWAInboundMessage({ eventId: `evt-${type}`, sessionId: 's', event: 'message.received', data: { id: `msg-${type}`, from: '123', type, [type]: media, data: 'raw-base64-must-not-propagate' } }, 'c')
    expect(normalized?.message.type).toBe(type)
    expect(normalized?.message[type]).toMatchObject({ id: type === 'video' ? 'vid-1' : type === 'image' ? 'img-1' : type === 'audio' ? 'aud-1' : 'doc-1' })
    expect(JSON.stringify(normalized)).not.toContain('raw-base64-must-not-propagate')
  })
  it('normalizes reactions and ignores non-message events', () => {
    const reaction = normalizeOpenWAInboundMessage({ eventId: 'evt-r', sessionId: 's', event: 'message.received', data: { id: 'r1', from: '123', type: 'reaction', reaction: { messageId: 'target', emoji: '👍' } } }, 'c')
    expect(reaction?.message.reaction).toEqual({ message_id: 'target', emoji: '👍' }); expect(normalizeOpenWAInboundMessage({ eventId: 'evt-status', sessionId: 's', event: 'status', data: {} }, 'c')).toBeNull()
  })
  it('fails closed when an inbound OpenWA message has no sender', () => { expect(() => normalizeOpenWAInboundMessage({ eventId: 'evt-bad', sessionId: 's', event: 'message.received', data: { id: 'x', text: 'hello' } }, 'c')).toThrow('sender') })
  it('fails closed when an OpenWA media message has no provider media identity', () => { expect(() => normalizeOpenWAInboundMessage({ eventId: 'evt-bad-media', sessionId: 's', event: 'message.received', data: { id: 'x', from: '123', type: 'image', image: { mimeType: 'image/jpeg' } } }, 'c')).toThrow('media identity') })
  it('normalizes missing timestamps without leaking provider-specific shape', () => { vi.spyOn(Date, 'now').mockReturnValue(1_792_950_000_000); const normalized = normalizeOpenWAInboundMessage({ eventId: 'evt-time', sessionId: 's', event: 'message.received', data: { id: 'x', from: '123', text: 'hello' } }, 'c'); expect(normalized?.message.timestamp).toBe('1792950000'); vi.restoreAllMocks() })
})
