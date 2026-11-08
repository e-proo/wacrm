import { MEDIA_MAX_BYTES } from '@/lib/storage/upload-media'
import type { OpenWAWebhookEnvelope } from './webhook'

/** Extract ONLY the signed, size-bounded inline base64 for local media
 * hydration. Do not put raw bytes into normalized CRM messages, logs or
 * downstream agent/automation event payloads. */
export function extractOpenWASignedInlineMedia(envelope: OpenWAWebhookEnvelope): string | undefined {
  const data = envelope.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const outer = data as Record<string, unknown>
  const message = outer.message && typeof outer.message === 'object' && !Array.isArray(outer.message)
    ? outer.message as Record<string, unknown> : outer
  const media = message.media
  if (!media || typeof media !== 'object' || Array.isArray(media)) return undefined
  const embedded = (media as Record<string, unknown>).data
  if (typeof embedded !== 'string' || !embedded || embedded.length > Math.ceil(MEDIA_MAX_BYTES * 4 / 3) + 4) return undefined
  return embedded
}
