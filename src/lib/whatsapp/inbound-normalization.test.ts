import { describe, expect, it, vi } from 'vitest'
import { normalizeMetaInboundMessage, normalizeOpenWAInboundMessage, normalizeOpenWAOwnSentMessage } from './inbound-normalization'

describe('provider-neutral inbound normalization', () => {
  it('normalizes equivalent Meta and OpenWA text into equivalent business fields', () => {
    const meta = normalizeMetaInboundMessage({ id: 'm-1', from: '967700000001', timestamp: '1792950000', type: 'text', text: { body: 'hello' } }, { profile: { name: 'Customer' }, wa_id: '967700000001' }, 'meta-connection')
    const openwa = normalizeOpenWAInboundMessage({ timestamp: '2026-10-26T18:00:00.000Z', eventId: 'evt-1', sessionId: 'session-1', event: 'message.received', data: { id: 'w-1', from: '967700000001', timestamp: '1792950000', text: 'hello', pushName: 'Customer' } }, 'openwa-connection')
    expect(openwa).not.toBeNull(); expect(openwa?.message.type).toBe(meta.message.type); expect(openwa?.message.from).toBe(meta.message.from); expect(openwa?.message.timestamp).toBe(meta.message.timestamp); expect(openwa?.message.text?.body).toBe(meta.message.text?.body); expect(openwa?.contact).toEqual(meta.contact); expect(meta.message.provider).toBe('meta_cloud'); expect(openwa?.message.provider).toBe('openwa')
  })
  it('preserves the exact OpenWA 1:1 LID chat while keeping senderPhone distinct', () => {
    const normalized = normalizeOpenWAInboundMessage({
      timestamp: '2026-10-26T18:00:00.000Z', eventId: 'evt-lid', sessionId: 's', event: 'message.received',
      data: { id: 'm-lid', from: '63256345444412@lid', chatId: '63256345444412@lid', senderPhone: '967700000001', text: 'hello' },
    }, 'conn')
    expect(normalized?.message).toMatchObject({ from: '967700000001', providerChatId: '63256345444412@lid' })
  })

  it('never turns a group sender or mismatched JID into a one-to-one OpenWA recipient', () => {
    const base = { timestamp: '2026-10-26T18:00:00.000Z', eventId: 'evt', sessionId: 's', event: 'message.received' }
    const group = normalizeOpenWAInboundMessage({ ...base, data: { id: 'm', from: '63256345444412@lid', chatId: '120363123456789@g.us', text: 'group' } }, 'conn')
    const mismatch = normalizeOpenWAInboundMessage({ ...base, data: { id: 'm2', from: '63256345444412@lid', chatId: '967700000001@c.us', text: 'mismatch' } }, 'conn')
    expect(group?.message.providerChatId).toBeUndefined()
    expect(mismatch?.message.providerChatId).toBeUndefined()
  })

  it('keeps an explicit phone JID without deriving an address from phone digits alone', () => {
    const base = { timestamp: '2026-10-26T18:00:00.000Z', eventId: 'evt', sessionId: 's', event: 'message.received' }
    const explicit = normalizeOpenWAInboundMessage({ ...base, data: { id: 'm', from: '967700000001@c.us', chatId: '967700000001@c.us', text: 'hello' } }, 'conn')
    const missing = normalizeOpenWAInboundMessage({ ...base, data: { id: 'm2', from: '967700000001', text: 'hello' } }, 'conn')
    expect(explicit?.message.providerChatId).toBe('967700000001@c.us')
    expect(missing?.message.providerChatId).toBeUndefined()
  })

  it('normalizes OpenWA reply context and preserves provider identity', () => {
    const normalized = normalizeOpenWAInboundMessage({ timestamp: '2026-10-26T18:00:00.000Z', eventId: 'evt-2', sessionId: 'session-2', instanceId: 'instance-1', event: 'message', data: { messageId: 'msg-2', sender: '15551234567', body: 'reply', replyToMessageId: 'parent-1', timestamp: 1792950000000 } }, 'connection-2')
    expect(normalized?.message).toMatchObject({ provider: 'openwa', connectionId: 'connection-2', providerMessageId: 'msg-2', from: '15551234567', timestamp: '1792950000', context: { id: 'parent-1' } })
  })
  it.each([
    ['image', { id: 'img-1', mimeType: 'image/jpeg', caption: 'photo', fileSize: 123 }],
    ['video', { mediaId: 'vid-1', mime_type: 'video/mp4', caption: 'clip' }],
    ['audio', { id: 'aud-1', mimeType: 'audio/ogg' }],
    ['document', { id: 'doc-1', mimeType: 'application/pdf', filename: 'invoice.pdf', fileSize: '456' }],
  ] as const)('normalizes OpenWA %s media descriptors without base64 persistence', (type, media) => {
    const normalized = normalizeOpenWAInboundMessage({ timestamp: '2026-10-26T18:00:00.000Z', eventId: `evt-${type}`, sessionId: 's', event: 'message.received', data: { id: `msg-${type}`, from: '123', type, [type]: media, data: 'raw-base64-must-not-propagate' } }, 'c')
    expect(normalized?.message.type).toBe(type)
    expect(normalized?.message[type]).toMatchObject({ id: type === 'video' ? 'vid-1' : type === 'image' ? 'img-1' : type === 'audio' ? 'aud-1' : 'doc-1' })
    expect(JSON.stringify(normalized)).not.toContain('raw-base64-must-not-propagate')
  })
  it('normalizes OpenWA voice and file payloads into supported attachment types', () => {
    const envelope = { eventId: 'evt-alias', timestamp: '2026-11-08T19:34:00Z', sessionId: 'sess', event: 'message.received' }
    const voice = normalizeOpenWAInboundMessage({ ...envelope, data: { id: 'v1', from: '123@c.us', chatId: '123@c.us', type: 'voice', media: { mimetype: 'audio/ogg', sizeBytes: 125 } } }, 'conn')
    const file = normalizeOpenWAInboundMessage({ ...envelope, data: { id: 'd1', from: '123@c.us', chatId: '123@c.us', type: 'file', media: { mimetype: 'application/pdf', filename: 'invoice.pdf' } } }, 'conn')
    expect(voice?.message).toMatchObject({ type: 'audio', audio: { id: 'v1', mime_type: 'audio/ogg' } })
    expect(file?.message).toMatchObject({ type: 'document', document: { id: 'd1', filename: 'invoice.pdf' } })
  })
  it('normalizes reactions and ignores non-message events', () => {
    const reaction = normalizeOpenWAInboundMessage({ timestamp: '2026-10-26T18:00:00.000Z', eventId: 'evt-r', sessionId: 's', event: 'message.received', data: { id: 'r1', from: '123', type: 'reaction', reaction: { messageId: 'target', emoji: '👍' } } }, 'c')
    expect(reaction?.message.reaction).toEqual({ message_id: 'target', emoji: '👍' }); expect(normalizeOpenWAInboundMessage({ timestamp: '2026-10-26T18:00:00.000Z', eventId: 'evt-status', sessionId: 's', event: 'status', data: {} }, 'c')).toBeNull()
  })
  it('fails closed when an inbound OpenWA message has no sender', () => { expect(() => normalizeOpenWAInboundMessage({ timestamp: '2026-10-26T18:00:00.000Z', eventId: 'evt-bad', sessionId: 's', event: 'message.received', data: { id: 'x', text: 'hello' } }, 'c')).toThrow('sender') })
  it('maps real OpenWA message media to its message and chat ID without persisting inline bytes', () => {
    const normalized = normalizeOpenWAInboundMessage({
      timestamp: '2026-10-26T18:00:00.000Z', eventId: 'evt-media', sessionId: 's', event: 'message.received',
      data: { id: 'm-123', from: '967700000001@c.us', chatId: '967700000001@c.us',
        type: 'image', media: { mimetype: 'image/jpeg', data: 'inline-secret', sizeBytes: 1024 } },
    }, 'c')
    expect(normalized?.message.from).toBe('967700000001')
    expect(normalized?.message.image).toMatchObject({ id: 'm-123', chat_id: '967700000001@c.us', mime_type: 'image/jpeg', file_size: 1024 })
    expect(JSON.stringify(normalized)).not.toContain('inline-secret')
  })
  it('handles a linked-device message.sent as own sent, never as inbound customer', () => {
    const echo = normalizeOpenWAOwnSentMessage({
      event: 'message.sent', eventId: 'sent-1', timestamp: '2026-11-08T19:00:00Z', sessionId: 'session',
      data: { id: 'native1', fromMe: true, from: '99999999999@c.us',
        chatId: '12345678901@c.us', body: 'From my phone', type: 'text' },
    }, 'conn')
    expect(echo).toMatchObject({
      id: 'native1', provider: 'openwa', connectionId: 'conn',
      providerChatId: '12345678901@c.us', from: '12345678901',
      text: { body: 'From my phone' },
    })
    expect(normalizeOpenWAInboundMessage({
      event: 'message.sent', eventId: 'sent-1', timestamp: '2026-11-08T19:00:00Z', sessionId: 'session',
      data: { id: 'native1', fromMe: true, from: '99999999999@c.us', chatId: '12345678901@c.us', type: 'text' },
    }, 'conn')).toBeNull()
    expect(normalizeOpenWAOwnSentMessage({
      event: 'message.sent', eventId: 'sent-2', timestamp: '2026-11-08T19:00:00Z', sessionId: 'session',
      data: { id: 'native2', fromMe: false, chatId: '12345678901@c.us' },
    }, 'conn')).toBeNull()
    expect(normalizeOpenWAOwnSentMessage({
      event: 'message.sent', eventId: 'sent-3', timestamp: '2026-11-08T19:00:00Z', sessionId: 'session',
      data: { id: 'native3', fromMe: true, chatId: '120363123456789@g.us' },
    }, 'conn')).toBeNull()
  })

  it('normalizes missing timestamps without leaking provider-specific shape', () => { vi.spyOn(Date, 'now').mockReturnValue(1_792_950_000_000); const normalized = normalizeOpenWAInboundMessage({ timestamp: '2026-10-26T18:00:00.000Z', eventId: 'evt-time', sessionId: 's', event: 'message.received', data: { id: 'x', from: '123', text: 'hello' } }, 'c'); expect(normalized?.message.timestamp).toBe('1792950000'); vi.restoreAllMocks() })
})
