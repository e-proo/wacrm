import type { OpenWAWebhookEnvelope } from '@/lib/whatsapp/transport/openwa/webhook'

export type InboundWhatsAppProvider = 'meta_cloud' | 'openwa'

export interface NormalizedInboundMessage {
  id: string
  provider: InboundWhatsAppProvider
  connectionId: string
  providerMessageId: string
  providerEventId?: string
  from: string
  recipient?: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  button?: { text?: string; payload?: string }
  context?: { id: string }
  providerMetadata?: Record<string, unknown>
}

export interface NormalizedInboundContact {
  profile: { name: string }
  wa_id: string
}

export interface NormalizedInbound {
  message: NormalizedInboundMessage
  contact: NormalizedInboundContact
}

interface MetaMessageLike extends Omit<NormalizedInboundMessage, 'provider' | 'connectionId' | 'providerMessageId'> {}

export function normalizeMetaInboundMessage(
  message: MetaMessageLike,
  contact: NormalizedInboundContact,
  connectionId: string,
): NormalizedInbound {
  return {
    message: {
      ...message,
      provider: 'meta_cloud',
      connectionId,
      providerMessageId: message.id,
    },
    contact,
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function timestampSeconds(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value))
  }
  const raw = stringValue(value)
  if (!raw) return String(Math.floor(Date.now() / 1000))
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw)
    return String(numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : numeric)
  }
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? String(Math.floor(parsed / 1000)) : String(Math.floor(Date.now() / 1000))
}

/**
 * Normalize the provider payload accepted by the signed OW-5 envelope.
 * OW-6 intentionally supports text/reply/reaction business semantics here;
 * provider media fetching/mirroring remains OW-8.
 */
export function normalizeOpenWAInboundMessage(
  envelope: OpenWAWebhookEnvelope,
  connectionId: string,
): NormalizedInbound | null {
  const event = envelope.event.toLowerCase().replace(/[\s_-]+/g, '.')
  if (!['message', 'message.received', 'message.receive', 'message.inbound'].includes(event)) {
    return null
  }

  const data = record(envelope.data)
  if (!data) throw new Error('OpenWA inbound message data is missing')
  const nested = record(data.message)
  const message = nested ?? data

  const providerMessageId =
    stringValue(message.id) ??
    stringValue(message.messageId) ??
    stringValue(message.message_id) ??
    envelope.eventId
  const from =
    stringValue(message.from) ??
    stringValue(message.sender) ??
    stringValue(message.senderId) ??
    stringValue(message.sender_id)
  if (!from) throw new Error('OpenWA inbound sender is missing')

  const rawText = message.text
  const textRecord = record(rawText)
  const text = stringValue(rawText) ?? stringValue(textRecord?.body) ?? stringValue(message.body)
  const rawType = stringValue(message.type)?.toLowerCase()
  const reactionRecord = record(message.reaction)
  const reactionTarget =
    stringValue(reactionRecord?.message_id) ??
    stringValue(reactionRecord?.messageId) ??
    stringValue(message.reactionMessageId)
  const reactionEmoji = stringValue(reactionRecord?.emoji) ?? stringValue(message.emoji)
  const type = rawType === 'reaction' || reactionTarget ? 'reaction' : 'text'

  const replyRecord = record(message.reply)
  const replyTo =
    stringValue(message.replyToMessageId) ??
    stringValue(message.reply_to_message_id) ??
    stringValue(replyRecord?.messageId) ??
    stringValue(replyRecord?.id)

  const senderName =
    stringValue(message.senderName) ??
    stringValue(message.pushName) ??
    stringValue(message.profileName) ??
    from

  const normalized: NormalizedInboundMessage = {
    id: providerMessageId,
    provider: 'openwa',
    connectionId,
    providerMessageId,
    providerEventId: envelope.eventId,
    from,
    recipient: stringValue(message.to) ?? stringValue(message.recipient),
    timestamp: timestampSeconds(message.timestamp ?? message.ts ?? message.createdAt),
    type,
    providerMetadata: {
      sessionId: envelope.sessionId,
      ...(envelope.instanceId ? { instanceId: envelope.instanceId } : {}),
    },
  }

  if (type === 'reaction') {
    if (!reactionTarget) throw new Error('OpenWA reaction target is missing')
    normalized.reaction = { message_id: reactionTarget, emoji: reactionEmoji ?? '' }
  } else {
    normalized.text = { body: text ?? '' }
    if (replyTo) normalized.context = { id: replyTo }
  }

  return {
    message: normalized,
    contact: { profile: { name: senderName }, wa_id: from },
  }
}
