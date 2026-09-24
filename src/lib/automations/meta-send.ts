import { sendTextMessage, sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/meta-send'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import {
  resolveTemplateRow,
  templateContentText,
} from '@/lib/whatsapp/template-body'
import { supabaseAdmin } from './admin-client'

// ------------------------------------------------------------
// Automation-side Meta sender.
//
// Mirrors the logic in src/app/api/whatsapp/send/route.ts but uses
// the service-role client (engine has no cookies) and accepts the
// user / conversation / contact identifiers the engine already has
// on hand. Kept here (rather than refactoring the user-facing send
// route) to avoid risk to the working manual-send path — they can
// converge in a later refactor.
// ------------------------------------------------------------

interface SendTextArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so an automation authored by user A still sends through
   *  the WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the automation/flow — used for INSERT audit
   *  columns (messages.sender_id-ish) and for resolving the agent's
   *  identity in logs. Not consulted for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
  /**
   * Multi-agent run UUID. When present the sender reserves exactly one
   * local `messages` row BEFORE the Meta call. This is the idempotency
   * boundary for an AI run; a retry never creates a second outbound send.
   */
  aiAgentRunId?: string
  /** Durable non-AI business notification key (for example an approved
   * customer-intent result). Mutually compatible with the same local-first
   * reservation semantics as aiAgentRunId. */
  engineIdempotencyKey?: string
}

interface SendTemplateArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  templateName: string
  language?: string
  params?: string[]
}

export async function engineSendText(args: SendTextArgs): Promise<{
  whatsapp_message_id: string
  local_message_id: string
}> {
  return sendViaMeta({ ...args, kind: 'text' })
}

export async function engineSendTemplate(
  args: SendTemplateArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'template' })
}

interface SendInteractiveArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  payload: InteractiveMessagePayload
}

/**
 * Send an interactive (reply-buttons or list) message from the
 * automation engine.
 *
 * Delegates to the Flows interactive senders
 * (`engineSendInteractiveButtons` / `engineSendInteractiveList`), which
 * already own the account-scoped lookup, phone-variant retry, and the
 * `messages` insert with `interactive_payload` + `sender_type='bot'`.
 * Both engines want identical behaviour here, so there's one
 * implementation rather than a second hand-rolled copy that could drift.
 */
export async function engineSendInteractive(
  args: SendInteractiveArgs,
): Promise<{ whatsapp_message_id: string }> {
  const { payload, accountId, userId, conversationId, contactId } = args
  const common = { accountId, userId, conversationId, contactId }
  if (payload.kind === 'buttons') {
    return engineSendInteractiveButtons({
      ...common,
      bodyText: payload.body,
      headerText: payload.header,
      footerText: payload.footer,
      buttons: payload.buttons,
    })
  }
  return engineSendInteractiveList({
    ...common,
    bodyText: payload.body,
    buttonLabel: payload.button_label,
    headerText: payload.header,
    footerText: payload.footer,
    sections: payload.sections,
  })
}

type SendInput =
  | (SendTextArgs & { kind: 'text' })
  | (SendTemplateArgs & { kind: 'template' })

async function sendViaMeta(input: SendInput): Promise<{
  whatsapp_message_id: string
  local_message_id: string
}> {
  const db = supabaseAdmin()

  // Scope the contact + config lookups by account_id, not user_id.
  // The engine uses the service-role client (bypassing RLS); without
  // this filter, an authenticated user could fire their own
  // automations against another tenant's contact UUID and send via
  // their own WhatsApp config to that contact's phone. The 017
  // migration moved both tables to account-scoped tenancy, so the
  // check is the same defense-in-depth as before, just keyed on the
  // new tenancy column.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', input.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  // Local template row — read for the body we persist below, not for
  // the Meta payload (the wire shape is deliberately unchanged here).
  // A missing row is fine: the send still goes out, we just can't
  // reconstruct the text the customer saw.
  const templateRow =
    input.kind === 'template'
      ? (
          await resolveTemplateRow(
            db,
            input.accountId,
            input.templateName,
            input.language,
          )
        ).row
      : null

  // For AI-agent text sends, reserve the LOCAL message row first. The unique
  // messages.ai_agent_run_id index means only one worker can own a run's
  // outbound send. `sending`/`failed` without a wamid is intentionally NOT
  // retried automatically because a provider timeout may have happened after
  // Meta accepted the message; automatic resend could duplicate customer text.
  let reservedMessageId: string | null = null
  const reservationColumn =
    input.kind === 'text' && input.aiAgentRunId
      ? 'ai_agent_run_id'
      : input.kind === 'text' && input.engineIdempotencyKey
        ? 'engine_idempotency_key'
        : null
  const reservationValue =
    input.kind === 'text'
      ? (input.aiAgentRunId ?? input.engineIdempotencyKey ?? null)
      : null
  if (input.kind === 'text' && reservationColumn && reservationValue) {
    const { data: existing, error: existingErr } = await db
      .from('messages')
      .select('id, message_id, status')
      .eq(reservationColumn, reservationValue)
      .maybeSingle()
    if (existingErr) throw existingErr
    if (existing) {
      const row = existing as { id: string; message_id: string | null; status: string }
      if (row.message_id && ['sent', 'delivered', 'read'].includes(row.status)) {
        return { whatsapp_message_id: row.message_id, local_message_id: row.id }
      }
      throw new Error(`AI_AGENT_SEND_REQUIRES_RECONCILIATION:${row.id}`)
    }

    const { data: reserved, error: reserveErr } = await db
      .from('messages')
      .insert({
        conversation_id: input.conversationId,
        sender_type: 'bot',
        content_type: 'text',
        content_text: input.text,
        message_id: null,
        status: 'sending',
        ...(input.aiAgentRunId ? { ai_agent_run_id: input.aiAgentRunId } : {}),
        ...(input.engineIdempotencyKey
          ? { engine_idempotency_key: input.engineIdempotencyKey }
          : {}),
      })
      .select('id')
      .single()
    if (reserveErr || !reserved) {
      // A concurrent worker may have won the unique run-id reservation.
      const { data: raced } = await db
        .from('messages')
        .select('id, message_id, status')
        .eq(reservationColumn, reservationValue)
        .maybeSingle()
      if (raced?.message_id && ['sent', 'delivered', 'read'].includes(raced.status)) {
        return { whatsapp_message_id: raced.message_id, local_message_id: raced.id }
      }
      throw reserveErr ?? new Error('ENGINE_SEND_RESERVATION_LOST')
    }
    reservedMessageId = (reserved as { id: string }).id
  }

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'template') {
      const r = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: input.templateName,
        language: input.language,
        params: input.params,
      })
      return r.messageId
    }
    const r = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: input.text,
    })
    return r.messageId
  }

  // Same phone-variant retry as /api/whatsapp/send — Meta sandbox and
  // numbers registered with/without a trunk 0 both require this to
  // reliably land a message.
  const variants = phoneVariants(sanitized)
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  // Persist the sent message so it appears in the inbox with a real
  // Meta message id. sender_type='bot' distinguishes automation sends
  // from manual agent sends.
  const content_type = input.kind === 'template' ? 'template' : 'text'
  // Templates persist the substituted body, same as the manual and
  // public-API send paths. This was unconditionally null, so every
  // automation template send rendered as an empty bubble (issue #483).
  const content_text =
    input.kind === 'text'
      ? input.text
      : templateContentText(templateRow, input.params ?? [])
  const template_name = input.kind === 'template' ? input.templateName : null

  const persisted = reservedMessageId
    ? await db
        .from('messages')
        .update({ message_id: waMessageId, status: 'sent' })
        .eq('id', reservedMessageId)
        .eq('status', 'sending')
        .select('id')
        .maybeSingle()
    : await db
        .from('messages')
        .insert({
          conversation_id: input.conversationId,
          sender_type: 'bot',
          content_type,
          content_text,
          template_name,
          message_id: waMessageId,
          status: 'sent',
        })
        .select('id')
        .single()
  const msgErr = persisted.error
  if (msgErr) {
    // Meta already has the message; record the DB error but don't pretend
    // the send failed. The engine wraps this in a log line.
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }
  const localMessageId = (persisted.data as { id: string } | null)?.id ?? reservedMessageId
  if (!localMessageId) {
    throw new Error('sent to Meta but local message id was not returned')
  }

  await db
    .from('conversations')
    .update({
      last_message_text:
        input.kind === 'template'
          ? (content_text ?? `[template:${input.templateName}]`)
          : input.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId)

  return { whatsapp_message_id: waMessageId, local_message_id: localMessageId }
}
