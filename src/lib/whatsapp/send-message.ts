import type { SupabaseClient } from '@supabase/supabase-js';

import {
  validateInteractivePayload,
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import type { MessageTemplate } from '@/types';
import {
  resolveTemplateRow,
  templateBodyParams,
  templateContentText,
} from '@/lib/whatsapp/template-body';
import { resolveMetaTransport } from '@/lib/whatsapp/transport/meta-adapter';
import {
  WhatsAppTransportError,
  type WhatsAppMediaKind,
  type WhatsAppTemplateSendParams,
  type WhatsAppTransportContent,
} from '@/lib/whatsapp/transport/types';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export const VALID_MESSAGE_TYPES = [
  'text',
  'template',
  'interactive',
  ...MEDIA_KINDS,
] as const;

export class SendMessageError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.status = status;
  }
}

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  templateParams?: string[];
  templateMessageParams?: WhatsAppTemplateSendParams;
  interactivePayload?: InteractiveMessagePayload | null;
  replyToMessageId?: string | null;
}

export interface SendMessageResult {
  messageId: string;
  whatsappMessageId: string;
}

export function validateSendMessageParams(params: {
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  templateName?: string | null;
  interactivePayload?: InteractiveMessagePayload | null;
}): void {
  const { messageType, contentText, mediaUrl, templateName, interactivePayload } = params;
  if (!messageType) throw new SendMessageError('bad_request', 'message_type is required', 400);

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);
  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    throw new SendMessageError('bad_request', `Unsupported message_type \"${messageType}\"`, 400);
  }
  if (messageType === 'text' && !contentText) {
    throw new SendMessageError('bad_request', 'content_text is required for text messages', 400);
  }
  if (messageType === 'template' && !templateName) {
    throw new SendMessageError('bad_request', 'template_name is required for template messages', 400);
  }
  if (messageType === 'interactive') {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) throw new SendMessageError('bad_request', result.error, 400);
  }
  if (isMediaKind && !mediaUrl) {
    throw new SendMessageError('bad_request', `media_url is required for ${messageType} messages`, 400);
  }
  if (
    isMediaKind &&
    messageType !== 'audio' &&
    typeof contentText === 'string' &&
    contentText.length > 1024
  ) {
    throw new SendMessageError('bad_request', 'Caption exceeds the 1024-character limit', 400);
  }
}

function mapTransportError(error: unknown): SendMessageError {
  if (error instanceof WhatsAppTransportError && error.code === 'authentication_or_configuration') {
    return new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }
  const message = error instanceof Error ? error.message : 'Unknown Meta API error';
  return new SendMessageError('meta_error', `Meta API error: ${message}`, 502);
}

export async function sendMessageToConversation(
  db: SupabaseClient,
  accountId: string,
  params: SendMessageParams
): Promise<SendMessageResult> {
  const {
    conversationId,
    messageType,
    contentText,
    mediaUrl,
    filename,
    templateName,
    templateLanguage,
    templateParams,
    templateMessageParams,
    interactivePayload,
    replyToMessageId,
  } = params;

  if (!conversationId) {
    throw new SendMessageError('bad_request', 'conversation_id is required', 400);
  }
  validateSendMessageParams({ messageType, contentText, mediaUrl, templateName, interactivePayload });
  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();
  if (convError || !conversation) {
    throw new SendMessageError('not_found', 'Conversation not found', 404);
  }

  const contact = conversation.contact;
  if (!contact?.phone) {
    throw new SendMessageError('bad_request', 'Contact phone number not found', 400);
  }
  const sanitizedPhone = sanitizePhoneForMeta(contact.phone);
  if (!isValidE164(sanitizedPhone)) {
    throw new SendMessageError('bad_request', 'Invalid phone number format', 400);
  }

  let contextMessageId: string | undefined;
  if (replyToMessageId) {
    const { data: parent, error: parentError } = await db
      .from('messages')
      .select('message_id, provider_message_id, provider, connection_id, conversation_id')
      .eq('id', replyToMessageId)
      .eq('conversation_id', conversationId)
      .maybeSingle();
    if (parentError || !parent) {
      throw new SendMessageError('bad_request', 'reply_to_message_id not found in this conversation', 400);
    }
    contextMessageId = parent.provider_message_id || parent.message_id || undefined;
    if (!contextMessageId) {
      console.warn('[send-message] reply target has no provider message id; sending without context');
    }
  }

  let templateRow: MessageTemplate | null = null;
  let sendLanguage = templateLanguage || 'en_US';
  if (messageType === 'template' && templateName) {
    const resolved = await resolveTemplateRow(db, accountId, templateName, templateLanguage);
    if (resolved.malformed) {
      throw new SendMessageError(
        'template_malformed',
        'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.',
        500
      );
    }
    templateRow = resolved.row;
    sendLanguage = resolved.language;
  }

  let content: WhatsAppTransportContent;
  if (messageType === 'template') {
    content = {
      kind: 'template',
      templateName: templateName!,
      language: sendLanguage,
      template: templateRow ?? undefined,
      messageParams: templateMessageParams,
      params: templateParams || [],
    };
  } else if (isMediaKind) {
    content = {
      kind: 'media',
      mediaKind: messageType as WhatsAppMediaKind,
      link: mediaUrl!,
      caption: contentText || undefined,
      filename: filename || undefined,
    };
  } else if (messageType === 'interactive') {
    content = { kind: 'interactive', payload: interactivePayload! };
  } else {
    content = { kind: 'text', text: contentText! };
  }

  let resolved;
  try {
    resolved = await resolveMetaTransport(db, accountId);
  } catch (error) {
    throw mapTransportError(error);
  }

  let sendResult;
  try {
    sendResult = await resolved.transport.send({
      accountId,
      connectionId: resolved.connectionId,
      recipient: sanitizedPhone,
      content,
      replyToProviderMessageId: contextMessageId,
    });
  } catch (error) {
    console.error(
      '[send-message] Meta transport send failed:',
      error instanceof Error ? error.message : error
    );
    throw mapTransportError(error);
  }

  const waMessageId = sendResult.providerMessageId;
  const workingPhone =
    typeof sendResult.providerMetadata?.workingRecipient === 'string'
      ? sendResult.providerMetadata.workingRecipient
      : sanitizedPhone;

  if (workingPhone !== sanitizedPhone) {
    console.log(`[send-message] Auto-corrected contact phone: ${sanitizedPhone} → ${workingPhone}`);
    await db
      .from('contacts')
      .update({ phone: workingPhone })
      .eq('id', contact.id)
      .eq('account_id', accountId);
  }

  const persistedText =
    messageType === 'interactive'
      ? interactivePayload!.body
      : messageType === 'template'
        ? templateContentText(
            templateRow,
            templateBodyParams(templateParams, templateMessageParams),
            contentText
          )
        : (contentText ?? null);

  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: messageType,
      content_text: persistedText,
      media_url: mediaUrl || null,
      template_name: templateName || null,
      interactive_payload: messageType === 'interactive' ? interactivePayload : null,
      message_id: waMessageId,
      provider: sendResult.provider,
      connection_id: sendResult.connectionId,
      provider_message_id: waMessageId,
      status: 'sent',
      reply_to_message_id: replyToMessageId || null,
    })
    .select()
    .single();

  if (msgError) {
    console.error('[send-message] error inserting sent message:', msgError);
    throw new SendMessageError(
      'db_error',
      `Message sent to Meta but failed to save to DB: ${msgError.message}`,
      500
    );
  }

  const lastMessageText =
    messageType === 'interactive'
      ? interactivePayloadPreviewText(interactivePayload!)
      : persistedText || `[${messageType}]`;

  await db
    .from('conversations')
    .update({
      last_message_text: lastMessageText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
    .eq('account_id', accountId);

  try {
    const { error: pauseErr } = await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .eq('status', 'active');
    if (pauseErr) console.error('[flows] pause-on-agent-send failed:', pauseErr.message);
  } catch (error) {
    console.error(
      '[flows] pause-on-agent-send threw:',
      error instanceof Error ? error.message : error
    );
  }

  return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
}
