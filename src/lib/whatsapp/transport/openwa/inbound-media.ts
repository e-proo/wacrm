import type { SupabaseClient } from '@supabase/supabase-js'
import { MEDIA_MAX_BYTES } from '@/lib/storage/upload-media'
import { mirrorInboundMedia, normalizeMimeType, type MirrorStorage } from '@/lib/whatsapp/mirror-inbound-media'
import type { NormalizedInboundMedia } from '@/lib/whatsapp/inbound-normalization'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'
import { resolveOpenWAClient } from './credentials'

const ALLOWED_PREFIXES: Record<string, readonly string[]> = {
  image: ['image/'], video: ['video/'], audio: ['audio/'], document: ['application/', 'text/'],
}

export async function mirrorOpenWAInboundMedia(args: {
  db: SupabaseClient
  storage: MirrorStorage
  accountId: string
  connectionId: string
  kind: 'image' | 'video' | 'audio' | 'document'
  media: NormalizedInboundMedia
  messageTimestamp: string
}): Promise<string | null> {
  const { db, storage, accountId, connectionId, kind, media, messageTimestamp } = args
  const mime = normalizeMimeType(media.mime_type)
  if (!mime || !ALLOWED_PREFIXES[kind].some((prefix) => mime.startsWith(prefix))) {
    throw new WhatsAppTransportError('invalid_request', `OpenWA ${kind} MIME type is not allowed`)
  }
  if (typeof media.file_size === 'number' && media.file_size > MEDIA_MAX_BYTES) {
    throw new WhatsAppTransportError('invalid_request', 'OpenWA media exceeds WACRM storage limit')
  }
  const { client, credentials } = await resolveOpenWAClient(db, accountId, connectionId)
  const sessionId = credentials.sessionId
  if (!sessionId) throw new WhatsAppTransportError('authentication_or_configuration', 'OpenWA media connection has no session identity')

  return mirrorInboundMedia({
    storage,
    accountId,
    mediaId: media.id,
    downloadUrl: `openwa://${connectionId}/${encodeURIComponent(media.id)}`,
    accessToken: '',
    mimeType: mime,
    fileSize: media.file_size,
    fileName: media.filename,
    messageTimestamp,
    download: async () => {
      const downloaded = await client.downloadMedia(sessionId, media.id, `media:${media.id}`)
      if (downloaded.contentLength !== null && downloaded.contentLength > MEDIA_MAX_BYTES) throw new Error('OpenWA media exceeds WACRM storage limit')
      return { buffer: downloaded.buffer, contentType: downloaded.contentType }
    },
  })
}
