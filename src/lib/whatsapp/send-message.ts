import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { validateInteractivePayload, interactivePayloadPreviewText, type InteractiveMessagePayload } from '@/lib/whatsapp/interactive';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import type { MessageTemplate } from '@/types';
import { resolveTemplateRow, templateBodyParams, templateContentText } from '@/lib/whatsapp/template-body';
import { resolveConversationTransport } from '@/lib/whatsapp/transport/router';
import { WhatsAppTransportError, type WhatsAppMediaKind, type WhatsAppTemplateSendParams, type WhatsAppTransportContent } from '@/lib/whatsapp/transport/types';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export const VALID_MESSAGE_TYPES = ['text', 'template', 'interactive', ...MEDIA_KINDS] as const;
export class SendMessageError extends Error { readonly code: string; readonly status: number; constructor(code: string, message: string, status: number) { super(message); this.name = 'SendMessageError'; this.code = code; this.status = status; } }
export interface SendMessageParams { conversationId: string; messageType: string; contentText?: string | null; mediaUrl?: string | null; filename?: string | null; templateName?: string | null; templateLanguage?: string | null; templateParams?: string[]; templateMessageParams?: WhatsAppTemplateSendParams; interactivePayload?: InteractiveMessagePayload | null; replyToMessageId?: string | null; connectionId?: string | null; idempotencyKey?: string | null; }
export interface SendMessageResult { messageId: string; whatsappMessageId: string; }

export function validateSendMessageParams(params: { messageType: string; contentText?: string | null; mediaUrl?: string | null; templateName?: string | null; interactivePayload?: InteractiveMessagePayload | null }): void {
  const { messageType, contentText, mediaUrl, templateName, interactivePayload } = params;
  if (!messageType) throw new SendMessageError('bad_request', 'message_type is required', 400);
  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);
  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) throw new SendMessageError('bad_request', `Unsupported message_type "${messageType}"`, 400);
  if (messageType === 'text' && !contentText) throw new SendMessageError('bad_request', 'content_text is required for text messages', 400);
  if (messageType === 'template' && !templateName) throw new SendMessageError('bad_request', 'template_name is required for template messages', 400);
  if (messageType === 'interactive') { const result = validateInteractivePayload(interactivePayload); if (!result.ok) throw new SendMessageError('bad_request', result.error, 400); }
  if (isMediaKind && !mediaUrl) throw new SendMessageError('bad_request', `media_url is required for ${messageType} messages`, 400);
  if (isMediaKind && mediaUrl) { let parsed: URL; try { parsed = new URL(mediaUrl); } catch { throw new SendMessageError('bad_request', 'media_url must be a valid URL', 400); } if (parsed.protocol !== 'https:') throw new SendMessageError('bad_request', 'media_url must use HTTPS', 400); }
  if (isMediaKind && messageType !== 'audio' && typeof contentText === 'string' && contentText.length > 1024) throw new SendMessageError('bad_request', 'Caption exceeds the 1024-character limit', 400);
}
function mapTransportError(error: unknown): SendMessageError { if (error instanceof WhatsAppTransportError) { if (error.code === 'authentication_or_configuration') return new SendMessageError('whatsapp_not_configured', error.message, 400); if (error.code === 'invalid_request' || error.code === 'unsupported_capability') return new SendMessageError(error.code, error.message, 400); if (error.code === 'connection_restricted' || error.code === 'ambiguous_outcome') return new SendMessageError(error.code, error.message, 409); if (error.code === 'recipient_invalid_or_unreachable') return new SendMessageError(error.code, error.message, 422); if (error.code === 'rate_limited') return new SendMessageError(error.code, error.message, 429); return new SendMessageError(error.code, error.message, 502); } return new SendMessageError('provider_error', error instanceof Error ? error.message : 'WhatsApp provider error', 502); }

export async function sendMessageToConversation(db: SupabaseClient, accountId: string, params: SendMessageParams): Promise<SendMessageResult> {
  const { conversationId, messageType, contentText, mediaUrl, filename, templateName, templateLanguage, templateParams, templateMessageParams, interactivePayload, replyToMessageId, connectionId, idempotencyKey } = params;
  if (!conversationId) throw new SendMessageError('bad_request', 'conversation_id is required', 400);
  validateSendMessageParams({ messageType, contentText, mediaUrl, templateName, interactivePayload });
  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);
  const { data: conversation, error: convError } = await db.from('conversations').select('*, contact:contacts(*)').eq('id', conversationId).eq('account_id', accountId).single();
  if (convError || !conversation) throw new SendMessageError('not_found', 'Conversation not found', 404);
  const contact = conversation.contact; if (!contact?.phone) throw new SendMessageError('bad_request', 'Contact phone number not found', 400);
  const sanitizedPhone = sanitizePhoneForMeta(contact.phone); if (!isValidE164(sanitizedPhone)) throw new SendMessageError('bad_request', 'Invalid phone number format', 400);
  let resolved; try { resolved = await resolveConversationTransport(db, accountId, conversationId, connectionId); } catch (error) { throw mapTransportError(error); }
  let contextMessageId: string | undefined;
  if (replyToMessageId) {
    const { data: parent, error: parentError } = await db.from('messages').select('message_id, provider_message_id, provider, connection_id, conversation_id').eq('id', replyToMessageId).eq('conversation_id', conversationId).maybeSingle();
    if (parentError || !parent) throw new SendMessageError('bad_request', 'reply_to_message_id not found in this conversation', 400);
    if (parent.connection_id && parent.connection_id !== resolved.connectionId) throw new SendMessageError('invalid_request', 'Reply target belongs to a different WhatsApp connection', 400);
    if (parent.provider && parent.provider !== resolved.transport.provider) throw new SendMessageError('invalid_request', 'Reply target belongs to a different WhatsApp provider', 400);
    contextMessageId = parent.provider_message_id || parent.message_id || undefined; if (!contextMessageId) throw new SendMessageError('invalid_request', 'Reply target has no provider-native message identity', 400);
  }
  let templateRow: MessageTemplate | null = null; let sendLanguage = templateLanguage || 'en_US';
  if (messageType === 'template' && templateName) { if (resolved.transport.provider !== 'meta_cloud') throw new SendMessageError('unsupported_capability', 'OpenWA does not use Meta approved-template policy', 400); const template = await resolveTemplateRow(db, accountId, templateName, templateLanguage); if (template.malformed) throw new SendMessageError('template_malformed', 'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.', 500); templateRow = template.row; sendLanguage = template.language; }
  let content: WhatsAppTransportContent;
  if (messageType === 'template') content = { kind: 'template', templateName: templateName!, language: sendLanguage, template: templateRow ?? undefined, messageParams: templateMessageParams, params: templateParams || [] };
  else if (isMediaKind) content = { kind: 'media', mediaKind: messageType as WhatsAppMediaKind, link: mediaUrl!, caption: contentText || undefined, filename: filename || undefined };
  else if (messageType === 'interactive') content = { kind: 'interactive', payload: interactivePayload! }; else content = { kind: 'text', text: contentText! };
  if (resolved.transport.provider === 'openwa' && (content.kind === 'template' || content.kind === 'interactive')) throw new SendMessageError('unsupported_capability', 'OpenWA does not support Meta template/interactive payloads', 400);
  const sendKey = idempotencyKey?.trim() || randomUUID();
  const persistedText = messageType === 'interactive' ? interactivePayload!.body : messageType === 'template' ? templateContentText(templateRow, templateBodyParams(templateParams, templateMessageParams), contentText) : (contentText ?? null);
  const pendingInsert = await db.from('messages').insert({ conversation_id: conversationId, sender_type: 'agent', content_type: messageType, content_text: persistedText, media_url: mediaUrl || null, template_name: templateName || null, interactive_payload: messageType === 'interactive' ? interactivePayload : null, provider: resolved.transport.provider, connection_id: resolved.connectionId, status: 'pending', reply_to_message_id: replyToMessageId || null, outbound_idempotency_key: sendKey }).select('id, message_id, provider_message_id, status').maybeSingle();
  let messageRecord = pendingInsert.data;
  if (pendingInsert.error || !messageRecord) { const { data: existing } = await db.from('messages').select('id, message_id, provider_message_id, status').eq('conversation_id', conversationId).eq('outbound_idempotency_key', sendKey).maybeSingle(); if (existing?.provider_message_id || existing?.message_id) return { messageId: existing.id, whatsappMessageId: existing.provider_message_id || existing.message_id }; if (existing) throw new SendMessageError('ambiguous_outcome', 'An outbound send with this idempotency key is already pending reconciliation', 409); throw new SendMessageError('db_error', `Failed to reserve outbound send identity: ${pendingInsert.error?.message ?? 'unknown error'}`, 500); }
  let sendResult; try { sendResult = await resolved.transport.send({ accountId, connectionId: resolved.connectionId, recipient: sanitizedPhone, content, replyToProviderMessageId: contextMessageId, idempotencyKey: sendKey }); } catch (error) { const transportError = error instanceof WhatsAppTransportError ? error : null; if (transportError?.code !== 'ambiguous_outcome') await db.from('messages').update({ status: 'failed' }).eq('id', messageRecord.id).eq('conversation_id', conversationId); throw mapTransportError(error); }
  const waMessageId = sendResult.providerMessageId;
  const { data: saved, error: saveError } = await db.from('messages').update({ message_id: waMessageId, provider: sendResult.provider, connection_id: sendResult.connectionId, provider_message_id: waMessageId, status: 'sent' }).eq('id', messageRecord.id).eq('conversation_id', conversationId).select('id').single();
  if (saveError || !saved) throw new SendMessageError('ambiguous_outcome', `Provider accepted the message but WACRM could not finalize persistence: ${saveError?.message ?? 'unknown error'}`, 409); messageRecord = { ...messageRecord, id: saved.id };
  const workingPhone = typeof sendResult.providerMetadata?.workingRecipient === 'string' ? sendResult.providerMetadata.workingRecipient : sanitizedPhone; if (workingPhone !== sanitizedPhone) await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id).eq('account_id', accountId);
  const lastMessageText = messageType === 'interactive' ? interactivePayloadPreviewText(interactivePayload!) : persistedText || `[${messageType}]`; await db.from('conversations').update({ last_message_text: lastMessageText, last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', conversationId).eq('account_id', accountId);
  try { const { error: pauseErr } = await supabaseAdmin().from('flow_runs').update({ status: 'paused_by_agent', ended_at: new Date().toISOString(), end_reason: 'agent_replied' }).eq('account_id', accountId).eq('contact_id', contact.id).eq('status', 'active'); if (pauseErr) console.error('[flows] pause-on-agent-send failed:', pauseErr.message); } catch (error) { console.error('[flows] pause-on-agent-send threw:', error instanceof Error ? error.message : error); }
  return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
}
