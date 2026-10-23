import type { SupabaseClient } from '@supabase/supabase-js'

import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import { resolveTemplateRow } from '@/lib/whatsapp/template-body'
import { resolveMetaTransport } from '@/lib/whatsapp/transport/meta-adapter'
import type { MessageTemplate } from '@/types'
import { findOrCreateContact } from '@/lib/api/v1/contacts'

export class BroadcastError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'BroadcastError'
    this.code = code
    this.status = status
  }
}

export interface BroadcastRecipientInput {
  to: string
  params?: string[]
}

export interface CreateBroadcastParams {
  name?: string | null
  templateName: string
  templateLanguage?: string | null
  recipients: BroadcastRecipientInput[]
}

interface PlannedRecipient {
  recipientRowId: string
  phone: string
  params: string[]
}

export interface BroadcastPlan {
  accountId: string
  connectionId: string
  broadcastId: string
  templateName: string
  templateLanguage: string
  templateRow: MessageTemplate | null
  planned: PlannedRecipient[]
  rejected: number
}

const MAX_RECIPIENTS = 1000

export async function createBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams,
): Promise<BroadcastPlan> {
  const { name, templateName, recipients } = params

  if (!templateName) {
    throw new BroadcastError('bad_request', "'template_name' is required", 400)
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError('bad_request', "'recipients' must be a non-empty array of { to, params? }", 400)
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError('bad_request', `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`, 400)
  }

  let connectionId: string
  try {
    connectionId = (await resolveMetaTransport(db, accountId)).connectionId
  } catch (error) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400,
    )
  }

  const resolvedTemplate = await resolveTemplateRow(db, accountId, templateName, params.templateLanguage)
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500,
    )
  }
  const templateRow = resolvedTemplate.row

  const resolved: { contactId: string; phone: string; params: string[] }[] = []
  let rejected = 0
  for (const r of recipients) {
    const sanitized = sanitizePhoneForMeta(typeof r.to === 'string' ? r.to : '')
    if (!isValidE164(sanitized)) {
      rejected++
      continue
    }
    const { id } = await findOrCreateContact(db, accountId, auditUserId, { phone: sanitized })
    resolved.push({
      contactId: id,
      phone: sanitized,
      params: Array.isArray(r.params) ? r.params.filter((p): p is string => typeof p === 'string') : [],
    })
  }

  const seenContact = new Set<string>()
  const deduped = resolved.filter((r) => {
    if (seenContact.has(r.contactId)) return false
    seenContact.add(r.contactId)
    return true
  })

  if (deduped.length === 0) {
    throw new BroadcastError('bad_request', 'No recipients had a valid E.164 phone number', 400)
  }

  const { data: createdRows, error: createErr } = await db.rpc('create_broadcast_with_recipients', {
    p_account_id: accountId,
    p_user_id: auditUserId,
    p_name: name || `API broadcast (${templateName})`,
    p_template_name: templateName,
    p_template_language: resolvedTemplate.language,
    p_total_recipients: deduped.length,
    p_contact_ids: deduped.map((r) => r.contactId),
    p_template_params: deduped.map((r) => r.params),
  })
  if (createErr || !createdRows || createdRows.length === 0) {
    console.error('[broadcast-core] create broadcast error:', createErr)
    throw new BroadcastError('internal', 'Failed to create broadcast', 500)
  }

  const broadcastId = createdRows[0].broadcast_id as string
  const byContact = new Map(deduped.map((r) => [r.contactId, r]))
  const planned: PlannedRecipient[] = createdRows.map(
    (row: { recipient_id: string; contact_id: string }) => {
      const r = byContact.get(row.contact_id)!
      return { recipientRowId: row.recipient_id, phone: r.phone, params: r.params }
    },
  )

  return {
    accountId,
    connectionId,
    broadcastId,
    templateName,
    templateLanguage: resolvedTemplate.language,
    templateRow,
    planned,
    rejected,
  }
}

export async function deliverBroadcast(db: SupabaseClient, plan: BroadcastPlan): Promise<void> {
  const resolved = await resolveMetaTransport(db, plan.accountId)
  if (resolved.connectionId !== plan.connectionId) {
    throw new BroadcastError('connection_changed', 'WhatsApp connection changed after the broadcast was planned', 409)
  }

  for (const recipient of plan.planned) {
    try {
      const result = await resolved.transport.send({
        accountId: plan.accountId,
        connectionId: plan.connectionId,
        recipient: recipient.phone,
        content: {
          kind: 'template',
          templateName: plan.templateName,
          language: plan.templateLanguage,
          template: plan.templateRow ?? undefined,
          params: recipient.params,
        },
      })
      await db
        .from('broadcast_recipients')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: result.providerMessageId,
          provider: result.provider,
          connection_id: result.connectionId,
          provider_message_id: result.providerMessageId,
          error_message: null,
        })
        .eq('id', recipient.recipientRowId)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      await db
        .from('broadcast_recipients')
        .update({ status: 'failed', error_message: message })
        .eq('id', recipient.recipientRowId)
    }
  }

  await finalizeBroadcastStatus(db, plan.broadcastId)
}

export async function finalizeBroadcastStatus(db: SupabaseClient, broadcastId: string): Promise<void> {
  const countWhere = async (status: string): Promise<number> => {
    const { count } = await db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .eq('status', status)
    return count ?? 0
  }

  if ((await countWhere('pending')) > 0) return

  const failed = await countWhere('failed')
  const { count: total } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)

  await db
    .from('broadcasts')
    .update({
      status: failed > 0 && failed === (total ?? 0) ? 'failed' : 'sent',
      updated_at: new Date().toISOString(),
    })
    .eq('id', broadcastId)
}
