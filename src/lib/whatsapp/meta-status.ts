import type { SupabaseClient } from '@supabase/supabase-js'

import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { applyWhatsAppStatus, normalizeMetaStatus } from './status-lifecycle'

export interface MetaStatusEvent {
  id: string
  status: string
  timestamp: string
  recipient_id: string
}

export async function processMetaStatusEvent(
  db: SupabaseClient,
  phoneNumberId: string,
  event: MetaStatusEvent,
): Promise<'updated' | 'ignored' | 'unknown'> {
  const status = normalizeMetaStatus(event.status)
  if (!status) return 'ignored'

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('account_id')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle()
  if (configError) throw configError
  if (!config?.account_id) return 'unknown'

  const { data: connection, error: connectionError } = await db
    .from('whatsapp_connections')
    .select('id')
    .eq('account_id', config.account_id)
    .eq('provider', 'meta_cloud')
    .eq('provider_external_id', phoneNumberId)
    .maybeSingle()
  if (connectionError) throw connectionError
  if (!connection?.id) return 'unknown'

  const result = await applyWhatsAppStatus(db, {
    provider: 'meta_cloud',
    accountId: config.account_id,
    connectionId: connection.id,
    providerMessageId: event.id,
    status,
    timestamp: event.timestamp,
  })

  if (result === 'updated') {
    const { data: message } = await db
      .from('messages')
      .select('conversation_id')
      .eq('provider', 'meta_cloud')
      .eq('connection_id', connection.id)
      .eq('provider_message_id', event.id)
      .maybeSingle()
    if (message?.conversation_id) {
      await dispatchWebhookEvent(db, config.account_id, 'message.status_updated', {
        whatsapp_message_id: event.id,
        conversation_id: message.conversation_id,
        status,
      })
    }
  }

  return result
}
