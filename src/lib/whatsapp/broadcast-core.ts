import type { SupabaseClient } from '@supabase/supabase-js'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import { resolveTemplateRow } from '@/lib/whatsapp/template-body'
import { resolveWhatsAppTransport } from '@/lib/whatsapp/transport/router'
import { WhatsAppTransportError, type WhatsAppProvider, type WhatsAppTransportContent } from '@/lib/whatsapp/transport/types'
import type { MessageTemplate } from '@/types'
import { OpenWAPreDispatchDenied } from '@/lib/whatsapp/transport/guardrails'
import { findOrCreateContact } from '@/lib/api/v1/contacts'
export class BroadcastError extends Error { readonly code: string; readonly status: number; constructor(code: string, message: string, status: number) { super(message); this.name = 'BroadcastError'; this.code = code; this.status = status } }
export interface BroadcastRecipientInput { to: string; params?: string[] }
export interface CreateBroadcastParams { name?: string | null; templateName: string; templateLanguage?: string | null; recipients: BroadcastRecipientInput[]; connectionId?: string | null }
interface PlannedRecipient { recipientRowId: string; phone: string; params: string[]; messageParams?: Record<string, unknown>; status?: string; errorMessage?: string | null }
export interface BroadcastPlan { accountId: string; connectionId: string; provider: WhatsAppProvider; broadcastId: string; templateName: string; templateLanguage: string; templateRow: MessageTemplate | null; planned: PlannedRecipient[]; rejected: number }
const MAX_RECIPIENTS = 1000
function transportError(error: unknown): BroadcastError { if (error instanceof WhatsAppTransportError) return new BroadcastError(error.code, error.message, error.code === 'connection_restricted' ? 409 : 400); return new BroadcastError('whatsapp_not_configured', 'WhatsApp not configured. Please set up your WhatsApp integration first.', 400) }
export async function createBroadcast(db: SupabaseClient, accountId: string, auditUserId: string, params: CreateBroadcastParams): Promise<BroadcastPlan> {
  const { name, templateName, recipients } = params
  if (!templateName) throw new BroadcastError('bad_request', "'template_name' is required", 400)
  if (!Array.isArray(recipients) || recipients.length === 0) throw new BroadcastError('bad_request', "'recipients' must be a non-empty array of { to, params? }", 400)
  if (recipients.length > MAX_RECIPIENTS) throw new BroadcastError('bad_request', `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`, 400)
  let transport; try { transport = await resolveWhatsAppTransport(db, accountId, params.connectionId) } catch (error) { throw transportError(error) }
  const resolvedTemplate = await resolveTemplateRow(db, accountId, templateName, params.templateLanguage); if (resolvedTemplate.malformed) throw new BroadcastError('template_malformed', 'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.', 500)
  const templateRow = resolvedTemplate.row; const resolved: { contactId: string; phone: string; params: string[] }[] = []; let rejected = 0
  for (const r of recipients) { const sanitized = sanitizePhoneForMeta(typeof r.to === 'string' ? r.to : ''); if (!isValidE164(sanitized)) { rejected++; continue }; const { id } = await findOrCreateContact(db, accountId, auditUserId, { phone: sanitized }); resolved.push({ contactId: id, phone: sanitized, params: Array.isArray(r.params) ? r.params.filter((p): p is string => typeof p === 'string') : [] }) }
  const seenContact = new Set<string>(); const deduped = resolved.filter((r) => { if (seenContact.has(r.contactId)) return false; seenContact.add(r.contactId); return true }); if (deduped.length === 0) throw new BroadcastError('bad_request', 'No recipients had a valid E.164 phone number', 400)
  const { data: createdRows, error: createErr } = await db.rpc('create_broadcast_with_recipients', { p_account_id: accountId, p_user_id: auditUserId, p_name: name || `API broadcast (${templateName})`, p_template_name: templateName, p_template_language: resolvedTemplate.language, p_total_recipients: deduped.length, p_contact_ids: deduped.map((r) => r.contactId), p_template_params: deduped.map((r) => r.params) }); if (createErr || !createdRows || createdRows.length === 0) throw new BroadcastError('internal', 'Failed to create broadcast', 500)
  const broadcastId = createdRows[0].broadcast_id as string; const byContact = new Map(deduped.map((r) => [r.contactId, r])); const planned: PlannedRecipient[] = createdRows.map((row: { recipient_id: string; contact_id: string }) => { const r = byContact.get(row.contact_id)!; return { recipientRowId: row.recipient_id, phone: r.phone, params: r.params } })
  const { error: pinError } = await db.from('broadcast_recipients').update({ provider: transport.transport.provider, connection_id: transport.connectionId }).eq('broadcast_id', broadcastId).in('id', planned.map((row) => row.recipientRowId)); if (pinError) throw new BroadcastError('internal', 'Failed to pin broadcast recipients to the selected WhatsApp connection', 500)
  return { accountId, connectionId: transport.connectionId, provider: transport.transport.provider, broadcastId, templateName, templateLanguage: resolvedTemplate.language, templateRow, planned, rejected }
}

/** OpenWA sends per-recipient business text, never an impersonation of approved Meta templates. */
export function renderOpenWABroadcastText(template: MessageTemplate | null, params: string[]): string {
  const body = template?.body_text?.trim()
  if (!body) throw new BroadcastError('unsupported_capability', 'OpenWA broadcast requires text content', 400)
  return body.replace(/\{\{(\d+)\}\}/g, (_match, number: string) => {
    const idx = Number(number) - 1
    if (!Number.isSafeInteger(idx) || idx < 0 || params[idx] === undefined) {
      throw new BroadcastError('template_params_missing', 'Recipient template values are incomplete', 400)
    }
    return params[idx]
  })
}
function broadcastContent(plan: BroadcastPlan, recipient: PlannedRecipient): WhatsAppTransportContent {
  if (plan.provider === 'meta_cloud') {
    return {
      kind: 'template', templateName: plan.templateName, language: plan.templateLanguage,
      template: plan.templateRow ?? undefined, params: recipient.params, messageParams: recipient.messageParams,
    }
  }
  return { kind: 'text', text: renderOpenWABroadcastText(plan.templateRow, recipient.params) }
}
export type BroadcastDeliveryState = 'sent' | 'failed' | 'requires_reconciliation' | 'skipped'
export interface BroadcastDeliveryResult {
  recipientId: string; phone: string; status: BroadcastDeliveryState; providerMessageId?: string; error?: string
}
/** Reserve once, dispatch once, settle once. Unknown outcomes never become automatic retries. */
export async function deliverBroadcast(db: SupabaseClient, plan: BroadcastPlan): Promise<BroadcastDeliveryResult[]> {
  const resolved = await resolveWhatsAppTransport(db, plan.accountId, plan.connectionId)
  if (resolved.connectionId !== plan.connectionId || resolved.transport.provider !== plan.provider) {
    throw new BroadcastError('connection_changed', 'WhatsApp connection changed after planning', 409)
  }
  const results: BroadcastDeliveryResult[] = []
  for (const recipient of plan.planned) {
    const previous = recipient.status ?? 'pending'
    // Historical 'failed' does not prove the provider rejected a send. Only
    // a typed, recorded WACRM pre-dispatch denial is safely retryable.
    if (previous !== 'pending' && !(previous === 'failed' && recipient.errorMessage === 'PRE_DISPATCH_DENIED')) {
      results.push({ recipientId: recipient.recipientRowId, phone: recipient.phone, status: 'skipped' })
      continue
    }
    const { data: reserved, error: reserveError } = await db.from('broadcast_recipients')
      .update({ status: 'sending', error_message: null })
      .eq('id', recipient.recipientRowId).eq('broadcast_id', plan.broadcastId)
      .eq('provider', plan.provider).eq('connection_id', plan.connectionId)
      .eq('status', previous).select('id').maybeSingle()
    if (reserveError) throw new BroadcastError('reservation_failed', 'Broadcast reservation failed before dispatch', 500)
    if (!reserved) {
      results.push({ recipientId: recipient.recipientRowId, phone: recipient.phone, status: 'skipped' })
      continue
    }
    try {
      const content = broadcastContent(plan, recipient)
      const result = await resolved.transport.send({
        accountId: plan.accountId, connectionId: plan.connectionId, recipient: recipient.phone,
        content, workload: 'broadcast',
        idempotencyKey: 'broadcast:' + plan.broadcastId + ':' + recipient.recipientRowId,
      })
      const { error: saveError } = await db.from('broadcast_recipients').update({
        status: 'sent', sent_at: new Date().toISOString(), whatsapp_message_id: result.providerMessageId,
        provider: result.provider, connection_id: result.connectionId,
        provider_message_id: result.providerMessageId, error_message: null,
      }).eq('id', recipient.recipientRowId).eq('broadcast_id', plan.broadcastId).eq('status', 'sending')
      if (saveError) throw new Error('Provider accepted but WACRM settlement failed')
      results.push({ recipientId: recipient.recipientRowId, phone: recipient.phone, status: 'sent', providerMessageId: result.providerMessageId })
    } catch (error) {
      // Any exception after a provider may have been called is uncertain,
      // including a DB settlement failure. Never claim an ordinary failure.
      const provenUnsent = error instanceof OpenWAPreDispatchDenied || error instanceof BroadcastError
      const status = provenUnsent ? 'failed' : 'requires_reconciliation'
      const reason = error instanceof OpenWAPreDispatchDenied ? 'PRE_DISPATCH_DENIED' : error instanceof BroadcastError ? error.code : 'RECONCILIATION_REQUIRED'
      const { error: settlementError } = await db.from('broadcast_recipients')
        .update({ status, error_message: reason })
        .eq('id', recipient.recipientRowId).eq('broadcast_id', plan.broadcastId).eq('status', 'sending')
      if (settlementError) throw new BroadcastError('settlement_failed', 'Broadcast outcome persistence failed; manual reconciliation required', 500)
      results.push({ recipientId: recipient.recipientRowId, phone: recipient.phone, status, error: reason })
      // Stop the cohort after any unsafe or policy failure. Remaining rows stay pending.
      break
    }
  }
  return results
}
export async function finalizeBroadcastStatus(db: SupabaseClient, broadcastId: string): Promise<void> {
  const countWhere = async (status: string): Promise<number> => {
    const { count, error } = await db.from('broadcast_recipients').select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId).eq('status', status)
    if (error) throw error
    return count ?? 0
  }
  for (const unsettled of ['pending', 'sending', 'requires_reconciliation']) {
    if ((await countWhere(unsettled)) > 0) return
  }
  const failed = await countWhere('failed')
  const { count: total, error: totalError } = await db.from('broadcast_recipients')
    .select('id', { count: 'exact', head: true }).eq('broadcast_id', broadcastId)
  if (totalError) throw totalError
  const { error: updateError } = await db.from('broadcasts').update({
    status: failed > 0 && failed === (total ?? 0) ? 'failed' : 'sent',
    updated_at: new Date().toISOString(),
  }).eq('id', broadcastId)
  if (updateError) throw updateError
}
