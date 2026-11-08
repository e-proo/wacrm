import type { OpenWAWebhookEnvelope } from '@/lib/whatsapp/transport/openwa/webhook'

export type InboundWhatsAppProvider = 'meta_cloud' | 'openwa'

export interface NormalizedInboundMedia {
  id: string
  chat_id?: string
  mime_type: string
  caption?: string
  filename?: string
  file_size?: number
}

export interface NormalizedInboundMessage {
  id: string
  provider: InboundWhatsAppProvider
  connectionId: string
  providerMessageId: string
  providerEventId?: string
  /** Provider-native 1:1 chat destination, separate from the CRM phone identity. */
  providerChatId?: string
  from: string
  recipient?: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: NormalizedInboundMedia
  video?: NormalizedInboundMedia
  document?: NormalizedInboundMedia
  audio?: NormalizedInboundMedia
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

type MetaMessageLike = Omit<NormalizedInboundMessage, 'provider' | 'connectionId' | 'providerMessageId'>

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

function numberValue(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined
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

function normalizeOpenWAMedia(message: Record<string, unknown>, kind: 'image' | 'video' | 'document' | 'audio'): NormalizedInboundMedia | null {
  const nested = record(message[kind]) ?? record(message.media)
  const id =
    stringValue(nested?.id) ??
    stringValue(nested?.mediaId) ??
    stringValue(nested?.media_id) ??
    stringValue(message.mediaId) ??
    stringValue(message.media_id) ??
    stringValue(message.id)
  if (!id) return null
  const mimeType =
    stringValue(nested?.mime_type) ??
    stringValue(nested?.mimeType) ??
    stringValue(nested?.mimetype) ??
    stringValue(message.mime_type) ??
    stringValue(message.mimeType) ??
    'application/octet-stream'
  const caption = stringValue(nested?.caption) ?? stringValue(message.caption)
  const filename = stringValue(nested?.filename) ?? stringValue(nested?.fileName) ?? stringValue(message.filename)
  const fileSize = numberValue(nested?.file_size ?? nested?.fileSize ?? nested?.sizeBytes ?? message.file_size ?? message.fileSize)
  return {
    id,
    ...(stringValue(message.chatId) ?? stringValue(nested?.chatId) ? { chat_id: stringValue(message.chatId) ?? stringValue(nested?.chatId) } : {}),
    mime_type: mimeType,
    ...(caption ? { caption } : {}),
    ...(filename ? { filename } : {}),
    ...(fileSize !== undefined ? { file_size: fileSize } : {}),
  }
}

/** Never infer a phone number from the digits of a WhatsApp privacy LID. */
function openWAOneToOneChatId(value: string | undefined): string | undefined {
  return value && /^[0-9]{5,20}@(c\.us|lid)$/.test(value) ? value : undefined
}

export function normalizeOpenWAInboundMessage(
  envelope: OpenWAWebhookEnvelope,
  connectionId: string,
): NormalizedInbound | null {
  const event = envelope.event.toLowerCase().replace(/[\s_-]+/g, '.')
  if (!['message', 'message.received', 'message.receive', 'message.inbound'].includes(event)) return null

  const data = record(envelope.data)
  if (!data) throw new Error('OpenWA inbound message data is missing')
  const nested = record(data.message)
  const message = nested ?? data

  const providerMessageId = stringValue(message.id) ?? stringValue(message.messageId) ?? stringValue(message.message_id) ?? envelope.eventId
  const providerSender = stringValue(message.from) ?? stringValue(message.sender) ?? stringValue(message.senderId) ?? stringValue(message.sender_id)
  const rawFrom = stringValue(message.senderPhone) ?? providerSender
  const from = rawFrom?.endsWith('@c.us') ? rawFrom.slice(0, -5) : rawFrom
  const explicitChatId = stringValue(message.chatId)
  const sourceSenderJid = openWAOneToOneChatId(providerSender)
  // A group/channel chat is never a 1:1 recipient. If the gateway supplies
  // both sender and chat JIDs, reject a mismatch instead of guessing.
  const candidateChatId = explicitChatId ? openWAOneToOneChatId(explicitChatId) : sourceSenderJid
  const providerChatId = candidateChatId && (!sourceSenderJid || candidateChatId === sourceSenderJid)
    ? candidateChatId
    : undefined
  if (!from) throw new Error('OpenWA inbound sender is missing')

  const rawText = message.text
  const textRecord = record(rawText)
  const text = stringValue(rawText) ?? stringValue(textRecord?.body) ?? stringValue(message.body)
  const rawType = stringValue(message.type)?.toLowerCase()
  const reactionRecord = record(message.reaction)
  const reactionTarget = stringValue(reactionRecord?.message_id) ?? stringValue(reactionRecord?.messageId) ?? stringValue(message.reactionMessageId)
  const reactionEmoji = stringValue(reactionRecord?.emoji) ?? stringValue(message.emoji)
  const normalizedMediaType = rawType === 'voice' ? 'audio' : rawType === 'file' ? 'document' : rawType
  const mediaKind = normalizedMediaType && ['image', 'video', 'document', 'audio'].includes(normalizedMediaType) ? normalizedMediaType as 'image' | 'video' | 'document' | 'audio' : null
  const type = rawType === 'reaction' || reactionTarget ? 'reaction' : mediaKind ?? 'text'

  const replyRecord = record(message.reply)
  const quotedMessage = record(message.quotedMessage)
  const replyTo = stringValue(quotedMessage?.id) ?? stringValue(message.replyToMessageId) ?? stringValue(message.reply_to_message_id) ?? stringValue(replyRecord?.messageId) ?? stringValue(replyRecord?.id)
  const senderName = stringValue(message.senderName) ?? stringValue(message.pushName) ?? stringValue(message.profileName) ?? from

  const normalized: NormalizedInboundMessage = {
    id: providerMessageId,
    provider: 'openwa',
    connectionId,
    providerMessageId,
    providerEventId: envelope.eventId,
    ...(providerChatId ? { providerChatId } : {}),
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
  } else if (mediaKind) {
    const media = normalizeOpenWAMedia(message, mediaKind)
    if (!media) throw new Error(`OpenWA ${mediaKind} message is missing provider media identity`)
    normalized[mediaKind] = media
    if (replyTo) normalized.context = { id: replyTo }
  } else {
    normalized.text = { body: text ?? '' }
    if (replyTo) normalized.context = { id: replyTo }
  }

  return { message: normalized, contact: { profile: { name: senderName }, wa_id: from } }
}

// An OpenWA message.sent event represents a write from the linked phone or
// the gateway. It must NEVER enter the inbound customer/AI pipeline.
// Reuse the same safe content normalization, with the authenticated
// provider-native chat as the remote peer rather than the account's own JID.
export function normalizeOpenWAOwnSentMessage(
  envelope: OpenWAWebhookEnvelope,
  connectionId: string,
): NormalizedInboundMessage | null {
  if (envelope.event.toLowerCase().replace(/[\s_-]+/g, '.') !== 'message.sent') return null
  const data = record(envelope.data)
  const message = record(data?.message) ?? data
  if (!message || message.fromMe === false || message.isGroup === true) return null
  const chatId = openWAOneToOneChatId(stringValue(message.chatId))
  if (!chatId) return null
  const remote = chatId.endsWith('@c.us') ? chatId.slice(0, -5) : chatId
  const normalized = normalizeOpenWAInboundMessage({
    ...envelope,
    event: 'message.received',
    data: { ...message, from: chatId, sender: chatId, senderPhone: remote, chatId },
  }, connectionId)
  return normalized?.message ?? null
}
