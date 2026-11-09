import type { SupabaseClient } from '@supabase/supabase-js'

export type WhatsAppDeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed'
export interface NormalizedWhatsAppStatus { provider: 'meta_cloud' | 'openwa'; accountId: string; connectionId: string; providerMessageId: string; status: WhatsAppDeliveryStatus; timestamp?: string; diagnostic?: string }
const LADDER = ['pending', 'sending', 'sent', 'delivered', 'read', 'replied'] as const
function level(value: string): number { return (LADDER as readonly string[]).indexOf(value) }
export function isForwardStatusTransition(current: string, incoming: WhatsAppDeliveryStatus): boolean { if (incoming === 'failed') return current === 'pending' || current === 'sending' || current === 'sent'; if (current === 'failed') return false; const currentLevel = level(current); const incomingLevel = level(incoming); if (incomingLevel < 0) return false; return currentLevel < 0 || incomingLevel > currentLevel }
export function normalizeMetaStatus(raw: string): WhatsAppDeliveryStatus | null { const value = raw.trim().toLowerCase(); return ['sent','delivered','read','failed'].includes(value) ? value as WhatsAppDeliveryStatus : null }
export function normalizeOpenWAStatus(raw: string): WhatsAppDeliveryStatus | null { const value = raw.trim().toLowerCase().replace(/[\s_-]+/g, '.'); if (['sent','server.ack','ack.server','ack'].includes(value)) return 'sent'; if (['delivered','delivery','device.ack','ack.device','received'].includes(value)) return 'delivered'; if (['read','played','read.ack','ack.read'].includes(value)) return 'read'; if (['failed','error','undeliverable','rejected'].includes(value)) return 'failed'; return null }
function safeDiagnostic(value: unknown): string | undefined { if (typeof value !== 'string') return undefined; const clean = value.replace(/bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/(token|secret|api[-_]?key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]').slice(0, 500); return clean || undefined }
/** OpenWA engines may report WhatsApp ACK as an integer or string. */
function openWAStatusValue(value: unknown): WhatsAppDeliveryStatus | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (value === -1) return 'failed'
    if (value === 1) return 'sent'
    if (value === 2) return 'delivered'
    if (value === 3 || value === 4) return 'read'
    return null
  }
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (/^-?\d+$/.test(raw)) return openWAStatusValue(Number(raw))
  return normalizeOpenWAStatus(raw)
}
function statusRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
export function parseOpenWAStatusEvent(data: unknown): { providerMessageId: string; status: WhatsAppDeliveryStatus; timestamp?: string; diagnostic?: string } | null {
  const row = statusRecord(data)
  if (!row) return null
  // The gateway may wrap the ACK in a message object. Never use the event
  // delivery ID as the WhatsApp message ID.
  const nested = statusRecord(row.message)
  const identity = nested ?? row
  const providerMessageId = [row.messageId, row.message_id, nested?.messageId, nested?.message_id, nested?.id, row.id]
    .find((v): v is string => typeof v === 'string' && !!v.trim())?.trim()
  const status = [row.status, row.ack, row.state, nested?.status, nested?.ack, nested?.state]
    .map(openWAStatusValue).find((value) => value !== null) ?? null
  if (!providerMessageId || !status) return null
  const timestampValue = row.timestamp ?? identity.timestamp
  const timestamp = typeof timestampValue === 'string' || typeof timestampValue === 'number' ? String(timestampValue) : undefined
  return { providerMessageId, status, timestamp, diagnostic: safeDiagnostic(row.error ?? row.reason ?? nested?.error ?? (typeof row.message === 'string' ? row.message : undefined)) }
}

export async function applyWhatsAppStatus(db: SupabaseClient, input: NormalizedWhatsAppStatus): Promise<'updated' | 'ignored' | 'unknown'> {
  const { data: connection, error: connectionError } = await db.from('whatsapp_connections').select('id').eq('id', input.connectionId).eq('account_id', input.accountId).eq('provider', input.provider).maybeSingle()
  if (connectionError) throw connectionError
  if (!connection) return 'unknown'

  const { data: message, error: messageError } = await db.from('messages').select('id, conversation_id, status').eq('provider', input.provider).eq('connection_id', input.connectionId).eq('provider_message_id', input.providerMessageId).maybeSingle()
  if (messageError) throw messageError
  const { data: recipient, error: recipientError } = await db.from('broadcast_recipients').select('id, status').eq('connection_id', input.connectionId).eq('provider', input.provider).eq('provider_message_id', input.providerMessageId).maybeSingle()
  if (recipientError) throw recipientError
  if (!message && !recipient) return 'unknown'

  let updated = false
  if (message && isForwardStatusTransition(message.status, input.status)) {
    const { error } = await db.from('messages').update({ status: input.status }).eq('id', message.id).eq('connection_id', input.connectionId).eq('provider', input.provider).eq('provider_message_id', input.providerMessageId)
    if (error) throw error
    updated = true
  }

  if (recipient && isForwardStatusTransition(recipient.status, input.status)) {
    const update: Record<string, unknown> = { status: input.status }
    const numeric = input.timestamp ? Number(input.timestamp) : NaN
    const ts = Number.isFinite(numeric) ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000).toISOString() : new Date().toISOString()
    if (input.status === 'sent') update.sent_at = ts
    if (input.status === 'delivered') update.delivered_at = ts
    if (input.status === 'read') update.read_at = ts
    if (input.status === 'failed' && input.diagnostic) update.error_message = input.diagnostic
    const { error } = await db.from('broadcast_recipients').update(update).eq('id', recipient.id).eq('connection_id', input.connectionId).eq('provider', input.provider).eq('provider_message_id', input.providerMessageId)
    if (error) throw error
    updated = true
  }

  return updated ? 'updated' : 'ignored'
}
