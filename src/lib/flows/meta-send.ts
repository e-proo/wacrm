import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import { resolveMetaTransport } from '@/lib/whatsapp/transport/meta-adapter'
import type { WhatsAppMediaKind, WhatsAppTransportContent } from '@/lib/whatsapp/transport/types'
import { supabaseAdmin } from './admin-client'

type ButtonsPayload = Extract<InteractiveMessagePayload, { kind: 'buttons' }>
type ListPayload = Extract<InteractiveMessagePayload, { kind: 'list' }>

interface SendTextEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  text: string
  aiGenerated?: boolean
}

interface SendMediaEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  kind: WhatsAppMediaKind
  link: string
  caption?: string
  filename?: string
}

interface SendInteractiveButtonsEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttons: ButtonsPayload['buttons']
  headerText?: string
  footerText?: string
}

interface SendInteractiveListEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttonLabel: string
  sections: ListPayload['sections']
  headerText?: string
  footerText?: string
}

interface FlowSendBase {
  accountId: string
  conversationId: string
  contactId: string
}

async function sendFlowContent(
  input: FlowSendBase,
  content: WhatsAppTransportContent,
): Promise<{ providerMessageId: string; connectionId: string; provider: 'meta_cloud'; workingPhone: string }> {
  const db = supabaseAdmin()
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) throw new Error('contact not found for this account')

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) throw new Error(`contact phone invalid: ${contact.phone}`)

  const resolved = await resolveMetaTransport(db, input.accountId)
  const result = await resolved.transport.send({
    accountId: input.accountId,
    connectionId: resolved.connectionId,
    recipient: sanitized,
    content,
  })
  const workingPhone =
    typeof result.providerMetadata?.workingRecipient === 'string'
      ? result.providerMetadata.workingRecipient
      : sanitized

  if (workingPhone !== sanitized) {
    await db
      .from('contacts')
      .update({ phone: workingPhone })
      .eq('id', contact.id)
      .eq('account_id', input.accountId)
  }

  return {
    providerMessageId: result.providerMessageId,
    connectionId: result.connectionId,
    provider: 'meta_cloud',
    workingPhone,
  }
}

async function persistFlowMessage(
  input: FlowSendBase,
  message: {
    contentType: string
    contentText: string | null
    providerMessageId: string
    connectionId: string
    interactivePayload?: InteractiveMessagePayload
    aiGenerated?: boolean
  },
): Promise<void> {
  const db = supabaseAdmin()
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type: message.contentType,
    content_text: message.contentText,
    interactive_payload: message.interactivePayload ?? null,
    message_id: message.providerMessageId,
    provider: 'meta_cloud',
    connection_id: message.connectionId,
    provider_message_id: message.providerMessageId,
    status: 'sent',
    ai_generated: message.aiGenerated ?? false,
  })
  if (msgErr) throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
}

async function updateConversation(accountId: string, conversationId: string, preview: string): Promise<void> {
  await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: preview,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
    .eq('account_id', accountId)
}

export async function engineSendText(
  args: SendTextEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const sent = await sendFlowContent(args, { kind: 'text', text: args.text })
  await persistFlowMessage(args, {
    contentType: 'text',
    contentText: args.text,
    providerMessageId: sent.providerMessageId,
    connectionId: sent.connectionId,
    aiGenerated: args.aiGenerated,
  })
  await updateConversation(args.accountId, args.conversationId, args.text)
  return { whatsapp_message_id: sent.providerMessageId }
}

export async function engineSendMedia(
  args: SendMediaEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const sent = await sendFlowContent(args, {
    kind: 'media',
    mediaKind: args.kind,
    link: args.link,
    caption: args.caption,
    filename: args.filename,
  })
  await persistFlowMessage(args, {
    contentType: args.kind,
    contentText: args.caption ?? null,
    providerMessageId: sent.providerMessageId,
    connectionId: sent.connectionId,
  })
  await updateConversation(
    args.accountId,
    args.conversationId,
    args.caption?.trim() || `[${args.kind}]`,
  )
  return { whatsapp_message_id: sent.providerMessageId }
}

export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'buttons' })
}

export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'list' })
}

type SendInput =
  | (SendInteractiveButtonsEngineArgs & { kind: 'buttons' })
  | (SendInteractiveListEngineArgs & { kind: 'list' })

async function sendInteractiveViaMeta(
  input: SendInput,
): Promise<{ whatsapp_message_id: string }> {
  const payload: InteractiveMessagePayload =
    input.kind === 'buttons'
      ? {
          kind: 'buttons',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          buttons: input.buttons,
        }
      : {
          kind: 'list',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          button_label: input.buttonLabel,
          sections: input.sections,
        }

  const sent = await sendFlowContent(input, { kind: 'interactive', payload })
  await persistFlowMessage(input, {
    contentType: 'interactive',
    contentText: input.bodyText,
    providerMessageId: sent.providerMessageId,
    connectionId: sent.connectionId,
    interactivePayload: payload,
  })
  await updateConversation(input.accountId, input.conversationId, input.bodyText)
  return { whatsapp_message_id: sent.providerMessageId }
}
