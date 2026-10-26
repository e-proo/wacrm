import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { engineSendInteractiveButtons, engineSendInteractiveList } from '@/lib/flows/meta-send'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import { resolveTemplateRow, templateContentText } from '@/lib/whatsapp/template-body'
import { resolveConversationTransport } from '@/lib/whatsapp/transport/router'
import { WhatsAppTransportError, type WhatsAppTransportContent } from '@/lib/whatsapp/transport/types'
import { supabaseAdmin } from './admin-client'

interface SendTextArgs { accountId: string; userId: string; conversationId: string; contactId: string; text: string; aiAgentRunId?: string; engineIdempotencyKey?: string }
interface SendTemplateArgs { accountId: string; userId: string; conversationId: string; contactId: string; templateName: string; language?: string; params?: string[] }
export async function engineSendText(args: SendTextArgs): Promise<{ whatsapp_message_id: string; local_message_id: string }> { return sendViaTransport({ ...args, kind: 'text' }) }
export async function engineSendTemplate(args: SendTemplateArgs): Promise<{ whatsapp_message_id: string }> { return sendViaTransport({ ...args, kind: 'template' }) }
interface SendInteractiveArgs { accountId: string; userId: string; conversationId: string; contactId: string; payload: InteractiveMessagePayload }
export async function engineSendInteractive(args: SendInteractiveArgs): Promise<{ whatsapp_message_id: string }> { const { payload, accountId, userId, conversationId, contactId } = args; const common = { accountId, userId, conversationId, contactId }; if (payload.kind === 'buttons') return engineSendInteractiveButtons({ ...common, bodyText: payload.body, headerText: payload.header, footerText: payload.footer, buttons: payload.buttons }); return engineSendInteractiveList({ ...common, bodyText: payload.body, buttonLabel: payload.button_label, headerText: payload.header, footerText: payload.footer, sections: payload.sections }) }
type SendInput = (SendTextArgs & { kind: 'text' }) | (SendTemplateArgs & { kind: 'template' })

async function sendViaTransport(input: SendInput): Promise<{ whatsapp_message_id: string; local_message_id: string }> {
  const db = supabaseAdmin()
  const { data: conversation, error: conversationError } = await db.from('conversations').select('id').eq('id', input.conversationId).eq('account_id', input.accountId).maybeSingle()
  if (conversationError || !conversation) throw new Error('conversation not found for this account')
  const { data: contact, error: contactErr } = await db.from('contacts').select('id, phone').eq('id', input.contactId).eq('account_id', input.accountId).maybeSingle()
  if (contactErr || !contact?.phone) throw new Error('contact not found for this account')
  const sanitized = sanitizePhoneForMeta(contact.phone); if (!isValidE164(sanitized)) throw new Error(`contact phone invalid: ${contact.phone}`)
  const resolved = await resolveConversationTransport(db, input.accountId, input.conversationId)
  if (input.kind === 'template' && resolved.transport.provider !== 'meta_cloud') throw new WhatsAppTransportError('unsupported_capability', 'OpenWA does not use Meta approved-template policy')
  const templateRow = input.kind === 'template' ? (await resolveTemplateRow(db, input.accountId, input.templateName, input.language)).row : null
  let reservedMessageId: string | null = null
  const reservationColumn = input.kind === 'text' && input.aiAgentRunId ? 'ai_agent_run_id' : input.kind === 'text' && input.engineIdempotencyKey ? 'engine_idempotency_key' : null
  const reservationValue = input.kind === 'text' ? (input.aiAgentRunId ?? input.engineIdempotencyKey ?? null) : null
  if (input.kind === 'text' && reservationColumn && reservationValue) {
    const { data: existing, error: existingErr } = await db.from('messages').select('id, message_id, provider_message_id, status').eq(reservationColumn, reservationValue).maybeSingle(); if (existingErr) throw existingErr
    if (existing) { const providerMessageId = existing.provider_message_id ?? existing.message_id; if (providerMessageId && ['sent','delivered','read'].includes(existing.status)) return { whatsapp_message_id: providerMessageId, local_message_id: existing.id }; throw new Error(`AI_AGENT_SEND_REQUIRES_RECONCILIATION:${existing.id}`) }
    const { data: reserved, error: reserveErr } = await db.from('messages').insert({ conversation_id: input.conversationId, sender_type: 'bot', content_type: 'text', content_text: input.text, message_id: null, provider: resolved.transport.provider, connection_id: resolved.connectionId, provider_message_id: null, status: 'sending', ...(input.aiAgentRunId ? { ai_agent_run_id: input.aiAgentRunId } : {}), ...(input.engineIdempotencyKey ? { engine_idempotency_key: input.engineIdempotencyKey } : {}) }).select('id').single()
    if (reserveErr || !reserved) { const { data: raced } = await db.from('messages').select('id, message_id, provider_message_id, status').eq(reservationColumn, reservationValue).maybeSingle(); if (raced) { const id = raced.provider_message_id ?? raced.message_id; if (id && ['sent','delivered','read'].includes(raced.status)) return { whatsapp_message_id: id, local_message_id: raced.id } } throw reserveErr ?? new Error('ENGINE_SEND_RESERVATION_LOST') }
    reservedMessageId = reserved.id
  }
  const content: WhatsAppTransportContent = input.kind === 'template' ? { kind: 'template', templateName: input.templateName, language: input.language ?? templateRow?.language ?? 'en_US', template: templateRow ?? undefined, params: input.params ?? [] } : { kind: 'text', text: input.text }
  const sendResult = await resolved.transport.send({ accountId: input.accountId, connectionId: resolved.connectionId, recipient: sanitized, content, idempotencyKey: reservationValue ?? undefined, workload: input.aiAgentRunId ? 'agent' : 'automation' })
  const waMessageId = sendResult.providerMessageId; const workingPhone = typeof sendResult.providerMetadata?.workingRecipient === 'string' ? sendResult.providerMetadata.workingRecipient : sanitized
  if (workingPhone !== sanitized) await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id).eq('account_id', input.accountId)
  const content_type = input.kind === 'template' ? 'template' : 'text'; const content_text = input.kind === 'text' ? input.text : templateContentText(templateRow, input.params ?? []); const template_name = input.kind === 'template' ? input.templateName : null
  const providerFields = { message_id: waMessageId, provider: sendResult.provider, connection_id: sendResult.connectionId, provider_message_id: waMessageId, status: 'sent' }
  const persisted = reservedMessageId ? await db.from('messages').update(providerFields).eq('id', reservedMessageId).eq('status', 'sending').select('id').maybeSingle() : await db.from('messages').insert({ conversation_id: input.conversationId, sender_type: 'bot', content_type, content_text, template_name, ...providerFields }).select('id').single()
  if (persisted.error) throw new Error(`provider accepted message but DB insert failed: ${persisted.error.message}`); const localMessageId = (persisted.data as { id: string } | null)?.id ?? reservedMessageId; if (!localMessageId) throw new Error('provider accepted message but local message id was not returned')
  await db.from('conversations').update({ last_message_text: input.kind === 'template' ? (content_text ?? `[template:${input.templateName}]`) : input.text, last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', input.conversationId).eq('account_id', input.accountId)
  return { whatsapp_message_id: waMessageId, local_message_id: localMessageId }
}
