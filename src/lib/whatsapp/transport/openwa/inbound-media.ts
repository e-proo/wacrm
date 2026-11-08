import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { MEDIA_MAX_BYTES } from '@/lib/storage/upload-media'
import { mirrorInboundMedia, normalizeMimeType, type MirrorStorage } from '@/lib/whatsapp/mirror-inbound-media'
import type { NormalizedInboundMedia, NormalizedInboundMessage } from '@/lib/whatsapp/inbound-normalization'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'
import { resolveOpenWAClient } from './credentials'

const ALLOWED_PREFIXES: Record<string, readonly string[]> = { image: ['image/'], video: ['video/'], audio: ['audio/'], document: ['application/', 'text/'] }

export async function mirrorOpenWAInboundMedia(args: { db: SupabaseClient; storage: MirrorStorage; accountId: string; connectionId: string; kind: 'image' | 'video' | 'audio' | 'document'; media: NormalizedInboundMedia; messageTimestamp: string; signedInlineMedia?: string }): Promise<string | null> {
  const { db, storage, accountId, connectionId, kind, media, messageTimestamp, signedInlineMedia } = args
  const mime = normalizeMimeType(media.mime_type)
  if (!mime || !ALLOWED_PREFIXES[kind].some((prefix) => mime.startsWith(prefix))) throw new WhatsAppTransportError('invalid_request', `OpenWA ${kind} MIME type is not allowed`)
  if (typeof media.file_size === 'number' && media.file_size > MEDIA_MAX_BYTES) throw new WhatsAppTransportError('invalid_request', 'OpenWA media exceeds WACRM storage limit')
  const { data: connection, error } = await db.from('whatsapp_connections').select('session_id').eq('id', connectionId).eq('account_id', accountId).eq('provider', 'openwa').maybeSingle()
  if (error || !connection?.session_id) throw new WhatsAppTransportError('authentication_or_configuration', 'OpenWA media connection has no scoped session identity', error)
  const { client } = await resolveOpenWAClient(db, accountId, connectionId)
  // Never put an OpenWA native message id (which may contain a phone/JID)
  // in a public Storage URL. A scoped stable digest also avoids truncation
  // collisions in buildMediaPath's 40-character basename.
  const stableMediaId = createHash('sha256').update(`${connectionId}:${media.id}`).digest('hex').slice(0, 20)
  return mirrorInboundMedia({
    storage, accountId, mediaId: stableMediaId, downloadUrl: `openwa://${connectionId}/${encodeURIComponent(media.id)}`, accessToken: '', mimeType: mime, fileSize: media.file_size, fileName: media.filename, messageTimestamp,
    download: async () => {
      // Prefer signed inline bytes when OpenWA omitted archiving the
      // gateway-side copy. Bound size and syntax; never log or forward
      // base64 to CRM agents, webhooks or the browser.
      if (signedInlineMedia && signedInlineMedia.length <= Math.ceil(MEDIA_MAX_BYTES * 4 / 3) + 4
        && signedInlineMedia.length % 4 === 0
        && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(signedInlineMedia)) {
        const bytes = Buffer.from(signedInlineMedia, 'base64')
        if (bytes.length > 0 && bytes.length <= MEDIA_MAX_BYTES) {
          return { buffer: bytes, contentType: mime }
        }
      }
      if (!media.chat_id) throw new WhatsAppTransportError('invalid_request', 'OpenWA media is missing the original chat ID')
      // The archive may be created just after the signed webhook is
      // dispatched. Retry only read-only 404s, never POST/send requests.
      let downloaded: Awaited<ReturnType<typeof client.downloadMedia>> | null = null
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          downloaded = await client.downloadMedia(connection.session_id, media.id, media.chat_id, `media:${media.id}`)
          break
        } catch (error) {
          const notReady = error instanceof WhatsAppTransportError
            && error.code === 'invalid_request' && /\(404\)/.test(error.message)
          if (!notReady || attempt === 2) throw error
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
        }
      }
      if (!downloaded) throw new Error('OpenWA media was not available')
      if (downloaded.contentLength !== null && downloaded.contentLength > MEDIA_MAX_BYTES) throw new Error('OpenWA media exceeds WACRM storage limit')
      return { buffer: downloaded.buffer, contentType: downloaded.contentType }
    },
  })
}

/** Fill the durable URL after the message row already exists, including a safe
 * retry when an inbound webhook is replayed. Never duplicate CRM messages. */
export async function hydrateOpenWAInboundMessageMedia(args: {
  db: SupabaseClient
  storage: MirrorStorage
  accountId: string
  conversationId: string
  inboundMessageId: string
  message: NormalizedInboundMessage
  signedInlineMedia?: string
}): Promise<boolean> {
  const { db, storage, accountId, conversationId, inboundMessageId, message, signedInlineMedia } = args
  if (message.provider !== 'openwa') return false
  const kind = message.type
  if (kind !== 'image' && kind !== 'video' && kind !== 'audio' && kind !== 'document') return false
  const media = message[kind]
  if (!media) return false

  const { data: stored, error: readError } = await db.from('messages')
    .select('media_url').eq('id', inboundMessageId).eq('conversation_id', conversationId).maybeSingle()
  if (readError || !stored) throw new Error('OpenWA media message could not be resolved in its conversation')
  if (stored.media_url) return false

  const mediaUrl = await mirrorOpenWAInboundMedia({
    db, storage, accountId, connectionId: message.connectionId, kind, media,
    messageTimestamp: message.timestamp, signedInlineMedia,
  })
  if (!mediaUrl) return false
  const { error: updateError } = await db.from('messages').update({ media_url: mediaUrl })
    .eq('id', inboundMessageId).eq('conversation_id', conversationId).is('media_url', null)
  if (updateError) throw new Error('OpenWA media URL could not be persisted')
  return true
}
