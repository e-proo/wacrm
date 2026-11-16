/** Flow send facade: uses the same account-scoped durable outbound core as manual, AI and automation sends. */
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { sendMessageToConversation, type SendMessageParams } from '@/lib/whatsapp/send-message'
import type { WhatsAppMediaKind } from '@/lib/whatsapp/transport/types'
import { supabaseAdmin } from './admin-client'

interface FlowSendBase { accountId: string; userId: string; conversationId: string; contactId: string; engineIdempotencyKey?: string }
interface SendTextEngineArgs extends FlowSendBase { text: string; aiGenerated?: boolean }
interface SendMediaEngineArgs extends FlowSendBase { kind: WhatsAppMediaKind; link: string; caption?: string; filename?: string }
type ButtonsPayload = Extract<InteractiveMessagePayload, { kind: 'buttons' }>
type ListPayload = Extract<InteractiveMessagePayload, { kind: 'list' }>
interface SendInteractiveButtonsEngineArgs extends FlowSendBase {
  bodyText: string; buttons: ButtonsPayload['buttons']; headerText?: string; footerText?: string
}
interface SendInteractiveListEngineArgs extends FlowSendBase {
  bodyText: string; buttonLabel: string; sections: ListPayload['sections']; headerText?: string; footerText?: string
}

async function sendFlowContent(
  input: FlowSendBase,
  message: Pick<SendMessageParams, 'messageType' | 'contentText' | 'mediaUrl' | 'filename' | 'interactivePayload' | 'aiGenerated'>,
): Promise<{ whatsapp_message_id: string }> {
  const sent = await sendMessageToConversation(supabaseAdmin(), input.accountId, {
    ...message,
    conversationId: input.conversationId,
    expectedContactId: input.contactId,
    senderType: 'bot',
    pauseActiveFlows: false,
    workload: 'automation',
    idempotencyKey: input.engineIdempotencyKey,
    engineIdempotencyKey: input.engineIdempotencyKey,
  })
  return { whatsapp_message_id: sent.whatsappMessageId }
}
export function engineSendText(input: SendTextEngineArgs): Promise<{ whatsapp_message_id: string }> {
  return sendFlowContent(input, { messageType: 'text', contentText: input.text, aiGenerated: input.aiGenerated })
}
export function engineSendMedia(input: SendMediaEngineArgs): Promise<{ whatsapp_message_id: string }> {
  return sendFlowContent(input, { messageType: input.kind, mediaUrl: input.link, contentText: input.caption, filename: input.filename })
}
export function engineSendInteractiveButtons(input: SendInteractiveButtonsEngineArgs): Promise<{ whatsapp_message_id: string }> {
  return sendFlowContent(input, {
    messageType: 'interactive', contentText: input.bodyText,
    interactivePayload: { kind: 'buttons', body: input.bodyText, header: input.headerText, footer: input.footerText, buttons: input.buttons },
  })
}
export function engineSendInteractiveList(input: SendInteractiveListEngineArgs): Promise<{ whatsapp_message_id: string }> {
  return sendFlowContent(input, {
    messageType: 'interactive', contentText: input.bodyText,
    interactivePayload: { kind: 'list', body: input.bodyText, header: input.headerText, footer: input.footerText, button_label: input.buttonLabel, sections: input.sections },
  })
}
