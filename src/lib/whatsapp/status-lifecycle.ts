import type { SupabaseClient } from '@supabase/supabase-js'

export type WhatsAppDeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed'

export interface NormalizedWhatsAppStatus {
  provider: 'meta_cloud' | 'openwa'
  accountId: string
  connectionId: string
  providerMessageId: string
  status: WhatsAppDeliveryStatus
  timestamp?: string
  diagnostic?: string
}

const LADDER = ['pending', 'sent', 'delivered', 'read', 'replied'] as const
function level(value: string): number { return (LADDER as readonly string[]).indexOf(value) }
export function isForwardStatusTransition(current: string, incoming: WhatsAppDeliveryStatus): boolean {
  if (incoming === 'failed') return current === 'pending' || current === 'sent'
  if (current === 'failed') return false
  const currentLevel = level(current); const incomingLevel = level(incoming)
  if (incomingLevel < 0) return false
  return currentLevel < 0 || incomingLevel > currentLevel
}

export function normalizeOpenWAStatus(raw: string): WhatsAppDeliveryStatus | null {
  const value = raw.trim().toLowerCase().replace(/[\s_-]+/g, '.')
  if (['sent', 'server.ack', 'ack.server', 'ack'].includes(value)) return 'sent'
  if (['delivered', 'delivery', 'device.ack', 'ack.device', 'received'].includes(value)) return 'delivered'
  if (['read', 'played', 'read.ack', 'ack.read'].includes(value)) return 'read'
  if (['failed', 'error', 'undeliverable', 'rejected'].includes(value)) return 'failed'
  return null
}

function safeDiagnostic(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/(token|secret|api[-_]?key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]').slice(0, 500)
  return clean || undefined
}

export function parseOpenWAStatusEvent(data: unknown): { providerMessageId: string; status: WhatsAppDeliveryStatus; timestamp?: string; diagnostic?: string } | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const row = data as Record<string, unknown>
  const providerMessageId = [row.messageId, row.message_id, row.id].find((v): v is string => typeof v === 'string' && !!v.trim())?.trim()
  const rawStatus = [row.status, row.ack, row.state].find((v): v is string => typeof v === 'string' && !!v.trim())
  if (!providerMessageId || !rawStatus) return null
  const status = normalizeOpenWAStatus(rawStatus); if (!status) return null
  const timestamp = typeof row.timestamp === 'string' || typeof row.timestamp === 'number' ? String(row.timestamp) : undefined
  return { providerMessageId, status, timestamp, diagnostic: safeDiagnostic(row.error ?? row.reason ?? row.message) }
}

export async function applyWhatsAppStatus(db: SupabaseClient, input: NormalizedWhatsAppStatus): Promise<'updated' | 'ignored' | 'unknown'> {
  const { data: message, error } = await db.from('messages').select('id, conversation_id, status').eq('provider', input.provider).eq('connection_id', input.connectionId).eq('provider_message_id', input.providerMessageId).maybeSingle()
  if (error) throw error
  if (!message) return 'unknown'
  if (!isForwardStatusTransition(message.status, input.status)) return 'ignored'
  const { error: updateError } = await db.from('messages').update({ status: input.status }).eq('id', message.id).eq('connection_id', input.connectionId).eq('provider', input.provider)
  if (updateError) throw updateError

  const { data: recipient, error: recipientError } = await db.from('broadcast_recipients').select('id, status').eq('connection_id', input.connectionId).eq('provider', input.provider).eq('provider_message_id', input.providerMessageId).maybeSingle()
  if (recipientError) throw recipientError
  if (recipient && isForwardStatusTransition(recipient.status, input.status)) {
    const update: Record<string, unknown> = { status: input.status }
    const numeric = input.timestamp ? Number(input.timestamp) : NaN
    const ts = Number.isFinite(numeric) ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000).toISOString() : new Date().toISOString()
    if (input.status === 'sent') update.sent_at = ts
    if (input.status === 'delivered') update.delivered_at = ts
    if (input.status === 'read') update.read_at = ts
    if (input.status === 'failed' && input.diagnostic) update.error_message = input.diagnostic
    const { error: updateRecipientError } = await db.from('broadcast_recipients').update(update).eq('id', recipient.id).eq('connection_id', input.connectionId).eq('provider', input.provider)
    if (updateRecipientError) throw updateRecipientError
  }
  return 'updated'
}
