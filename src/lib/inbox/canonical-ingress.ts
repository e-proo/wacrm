import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedInboundMessage } from '@/lib/whatsapp/inbound-normalization'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/openwa/environment'

export type CanonicalReceipt = { eventId: string; token: string; sessionId: string; instanceId: string | null }
export type CanonicalDispatch = { canonicalId: string; messageId: string; claim: string; firstInbound: boolean; contactCreated: boolean; conversationCreated: boolean; replyToMessageId: string | null }

// Explicit non-production test gate. Do not enable until the acceptance and
// channel policy gates are satisfied. No fallback to legacy on canonical denial.
export function canonicalInboxTestMode(): boolean {
  return isOpenWATestProject() && process.env.WACRM_INBOX_CANONICAL_INGRESS === 'test_only'
}

export function canonicalReviewPayload(message: NormalizedInboundMessage) {
  return {
    nativeId: message.providerMessageId, identityKind: message.providerMessageIdentityKind ?? 'event_fallback',
    from: message.from, chatId: message.providerChatId ?? null, recipient: message.recipient ?? null,
    timestamp: message.timestamp, type: message.type, text: message.text?.body ?? null,
    replyNativeId: message.context?.id ?? null, reaction: message.reaction ?? null,
    media: message.image ?? message.video ?? message.audio ?? message.document ?? message.sticker ?? null,
  }
}
export async function holdCanonicalReview(db: SupabaseClient, accountId: string, message: NormalizedInboundMessage, receipt: CanonicalReceipt, reason: 'outbound_echo_unproven' | 'reaction_unproven') {
  const { error } = await db.rpc('inbox_hold_signed_observation', {
    p_account: accountId, p_connection: message.connectionId, p_event: receipt.eventId, p_token: receipt.token,
    p_session: receipt.sessionId, p_instance: receipt.instanceId, p_reason: reason, p_payload: canonicalReviewPayload(message),
  })
  if (error) throw new Error('Canonical observation review could not be persisted')
}
export async function commitAndClaimCanonicalInbound(db: SupabaseClient, input: {
  accountId: string; conversationId: string; message: NormalizedInboundMessage; receipt: CanonicalReceipt
  contentType: string; contentText: string | null; mediaType: string | null
  contactCreated: boolean; conversationCreated: boolean
}): Promise<CanonicalDispatch | null> {
  const { accountId, conversationId, message, receipt } = input
  if (message.provider !== 'openwa' || message.providerEventId !== receipt.eventId || message.providerMetadata?.sessionId !== receipt.sessionId ||
    (message.providerMetadata?.instanceId ?? null) !== receipt.instanceId) throw new Error('Canonical receipt binding mismatch')
  const { data, error } = await db.rpc('inbox_commit_canonical_inbound_context', {
    p_account: accountId, p_connection: message.connectionId, p_event: receipt.eventId, p_token: receipt.token,
    p_conversation: conversationId, p_session: receipt.sessionId, p_instance: receipt.instanceId,
    p_native_id: message.providerMessageId, p_native_proven: message.providerMessageIdentityKind === 'native',
    p_content_type: input.contentType, p_content_text: input.contentText, p_media_type: input.mediaType,
    p_chat_id: message.providerChatId ?? null, p_timestamp: new Date(Number(message.timestamp)*1000).toISOString(),
    p_reply_native_id: message.context?.id ?? null, p_payload: canonicalReviewPayload(message),
    p_contact_created: input.contactCreated, p_conversation_created: input.conversationCreated,
  })
  if (error || !data || !['review','duplicate','inserted'].includes(data.state)) throw new Error('Canonical inbound persistence unconfirmed')
  if (data.state === 'review' || data.canClaim !== true) return null
  if (typeof data.canonicalId !== 'string' || typeof data.messageId !== 'string' || !data.dispatchContext) throw new Error('Canonical dispatch context missing')
  const { data: claim, error: claimError } = await db.rpc('inbox_claim_canonical_effect', {
    p_account: accountId, p_canonical: data.canonicalId, p_connection: message.connectionId, p_event: receipt.eventId, p_receipt_token: receipt.token,
  })
  if (claimError) throw new Error('Canonical effect claim failed')
  if (typeof claim !== 'string') return null
  return { canonicalId: data.canonicalId, messageId: data.messageId, claim,
    firstInbound: data.dispatchContext.firstInbound === true, contactCreated: data.dispatchContext.contactCreated === true,
    conversationCreated: data.dispatchContext.conversationCreated === true,
    replyToMessageId: typeof data.dispatchContext.replyToMessageId === 'string' ? data.dispatchContext.replyToMessageId : null }
}
export async function finishCanonicalDispatch(db: SupabaseClient, accountId: string, run: CanonicalDispatch, returned: boolean) {
  const { data, error } = await db.rpc('inbox_finish_canonical_effect', { p_account: accountId, p_canonical: run.canonicalId, p_claim: run.claim, p_returned: returned })
  if (error || data !== true) throw new Error('Canonical effect outcome unconfirmed')
}

export async function canonicalReceiptOutcome(db: SupabaseClient, accountId: string, message: NormalizedInboundMessage, receipt: CanonicalReceipt): Promise<{ state: 'completed' | 'pending' | 'review'; messageId?: string; conversationId?: string }> {
  const { data, error } = await db.rpc('inbox_canonical_receipt_outcome', {
    p_account: accountId, p_connection: message.connectionId, p_event: receipt.eventId, p_token: receipt.token, p_native: message.providerMessageId,
  })
  if (error || !data || !['completed','pending','review'].includes(data.state)) throw new Error('Canonical receipt outcome unavailable')
  return { state: data.state, messageId: typeof data.messageId === 'string' ? data.messageId : undefined,
    conversationId: typeof data.conversationId === 'string' ? data.conversationId : undefined }
}

/** Per-stage record is a durable uncertainty boundary, never a promise that
 * the external recipient received an effect. A started claim isn't replayed. */
export async function runCanonicalStage<T>(db: SupabaseClient, accountId: string, run: CanonicalDispatch, stage: string, fn: () => Promise<T>): Promise<T> {
  const args = {p_account:accountId,p_canonical:run.canonicalId,p_claim:run.claim,p_stage:stage}
  const {data,error}=await db.rpc('inbox_begin_canonical_stage',args)
  if(error||data!==true) throw new Error('Canonical stage unavailable or already claimed')
  let result: T
  try { result=await fn() } catch(error) {
    await db.rpc('inbox_finish_canonical_stage',{...args,p_returned:false})
    throw error
  }
  const done=await db.rpc('inbox_finish_canonical_stage',{...args,p_returned:true})
  if(done.error||done.data!==true) throw new Error('Canonical stage outcome unconfirmed')
  return result
}
export function hasExplicitCanonicalPeer(message: NormalizedInboundMessage): boolean {
  const chat=message.providerChatId
  if(message.provider!=='openwa'||!chat||!/^\d{5,20}@(c\.us|lid)$/.test(chat)) return false
  const phone=message.from.replace(/^\+/,'')
  return /^[1-9][0-9]{6,14}$/.test(phone) && (chat.endsWith('@lid') ? phone!==chat.slice(0,-4) : phone===chat.slice(0,-5))
}
