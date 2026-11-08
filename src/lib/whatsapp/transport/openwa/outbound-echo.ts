import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedInboundMessage } from '@/lib/whatsapp/inbound-normalization'
import { findOrCreateContact, findOrCreateConversation } from '@/lib/whatsapp/inbound-processor'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { hydrateOpenWAInboundMessageMedia } from './inbound-media'
import type { MirrorStorage } from '@/lib/whatsapp/mirror-inbound-media'

/**
 * Persist a signed own-device echo in the existing WACRM Inbox. Never run
 * customer unread bumps, automations, agents, or broadcasts for our own
 * outbound messages. Native provider identity is the dedup boundary.
 *
 * We cannot assert a 10-second-timed-out API message and a later echo are
 * identical merely because they share a chat/time/type. Leave unmatched
 * idempotency reservations for explicit reconciliation, not blind resend.
 */
export async function processOpenWAOwnSentEcho(input: {
  db: SupabaseClient
  storage: MirrorStorage
  accountId: string
  connectionId: string
  ownerUserId: string
  message: NormalizedInboundMessage
  signedInlineMedia?: string
}): Promise<'inserted' | 'existing' | 'ignored'> {
  const { db, storage, accountId, connectionId, ownerUserId, message, signedInlineMedia } = input
  if (message.provider !== 'openwa' || message.connectionId !== connectionId) return 'ignored'
  const chatId = message.providerChatId
  if (!chatId || !/^[0-9]{5,20}@(c\.us|lid)$/.test(chatId)) return 'ignored'

  const { data: existing, error: existingError } = await db.from('messages')
    .select('id, conversation_id, media_url').eq('provider', 'openwa').eq('connection_id', connectionId)
    .eq('provider_message_id', message.providerMessageId).maybeSingle()
  if (existingError) throw existingError
  if (existing) {
    // A prior echo can persist before the gateway archives its attachment.
    // Replays may fill only the missing media URL, never duplicate the row
    // or invoke the customer inbound/automation pipeline.
    if (!existing.media_url && ['image', 'video', 'audio', 'document'].includes(message.type)) {
      const { data: scopedConversation, error: scopeError } = await db.from('conversations')
        .select('id').eq('id', existing.conversation_id).eq('account_id', accountId).maybeSingle()
      if (scopeError) throw scopeError
      if (scopedConversation) {
        try {
          await hydrateOpenWAInboundMessageMedia({
            db, storage, accountId, conversationId: scopedConversation.id,
            inboundMessageId: existing.id, message, signedInlineMedia,
          })
        } catch (error) {
          console.warn('[openwa-echo] replay media hydration unavailable', {
            kind: message.type, code: error instanceof Error ? error.name : 'unknown',
          })
        }
      }
    }
    return 'existing'
  }

  let conversationId: string | null = null
  if (chatId.endsWith('@lid')) {
    // An LID is NOT a phone number. Only a previously verified signed
    // inbound mapping for this exact connection can establish the chat.
    const { data: mapped, error: mappingError } = await db.from('messages')
      .select('conversation_id').eq('provider', 'openwa').eq('connection_id', connectionId)
      .eq('provider_chat_id', chatId).order('created_at', { ascending: false })
      .limit(1).maybeSingle()
    if (mappingError) throw mappingError
    if (!mapped?.conversation_id) return 'ignored'
    const { data: conversation, error: scopeError } = await db.from('conversations')
      .select('id').eq('id', mapped.conversation_id).eq('account_id', accountId).maybeSingle()
    if (scopeError) throw scopeError
    conversationId = conversation?.id ?? null
  } else {
    const phone = normalizePhone(chatId.slice(0, -5))
    if (!phone) return 'ignored'
    const contact = await findOrCreateContact(accountId, ownerUserId, phone, '')
    if (!contact) throw new Error('OpenWA own-sent contact could not be resolved')
    const result = await findOrCreateConversation(accountId, ownerUserId, contact.contact.id)
    if (!result) throw new Error('OpenWA own-sent conversation could not be resolved')
    conversationId = result.conversation.id
  }
  if (!conversationId) return 'ignored'

  const kind = ['image','video','audio','document'].includes(message.type)
    ? message.type as 'image' | 'video' | 'audio' | 'document' : 'text'
  const media = kind !== 'text' ? message[kind] : null
  const contentText = kind === 'text' ? message.text?.body ?? '' : media?.caption ?? media?.filename ?? `[${kind}]`
  if (kind === 'text' && !contentText.trim()) return 'ignored'
  const createdAt = new Date(Number(message.timestamp) * 1000)
  const { data: rows, error: insertError } = await db.from('messages').upsert({
    conversation_id: conversationId,
    sender_type: 'agent',
    content_type: kind,
    content_text: contentText,
    media_type: media?.mime_type ?? null,
    message_id: message.providerMessageId,
    provider: 'openwa',
    connection_id: connectionId,
    provider_message_id: message.providerMessageId,
    status: 'sent',
    created_at: Number.isFinite(createdAt.valueOf()) ? createdAt.toISOString() : new Date().toISOString(),
  }, { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }).select('id')
  if (insertError) throw insertError
  const insertedId = rows?.[0]?.id
  if (!insertedId) return 'existing'

  if (media) {
    try {
      await hydrateOpenWAInboundMessageMedia({
        db, storage, accountId, conversationId, inboundMessageId: insertedId, message, signedInlineMedia,
      })
    } catch (error) {
      console.warn('[openwa-echo] own-sent media hydration unavailable', {
        kind, code: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
  const { error: previewError } = await db.from('conversations').update({
    last_message_text: contentText,
    last_message_at: Number.isFinite(createdAt.valueOf()) ? createdAt.toISOString() : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', conversationId).eq('account_id', accountId)
  if (previewError) throw previewError
  return 'inserted'
}
