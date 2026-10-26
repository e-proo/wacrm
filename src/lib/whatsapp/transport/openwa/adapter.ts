import type { SupabaseClient } from '@supabase/supabase-js'

import {
  WhatsAppTransportError,
  type WhatsAppTransport,
  type WhatsAppTransportSendRequest,
  type WhatsAppTransportSendResult,
} from '@/lib/whatsapp/transport/types'
import { resolveOpenWAClient } from './credentials'

interface OpenWAConnectionRow { id: string; account_id: string; provider: 'openwa'; status: string; session_id: string | null }
export interface ResolvedOpenWATransport { connectionId: string; transport: WhatsAppTransport }

class OpenWAWhatsAppTransport implements WhatsAppTransport {
  readonly provider = 'openwa' as const
  constructor(private readonly accountId: string, private readonly connectionId: string, private readonly sessionId: string, private readonly client: Awaited<ReturnType<typeof resolveOpenWAClient>>['client']) {}

  async send(request: WhatsAppTransportSendRequest): Promise<WhatsAppTransportSendResult> {
    if (request.accountId !== this.accountId || request.connectionId !== this.connectionId) throw new WhatsAppTransportError('invalid_request', 'WhatsApp transport request does not match the resolved OpenWA connection')
    if (!request.idempotencyKey) throw new WhatsAppTransportError('invalid_request', 'OpenWA outbound requires a stable WACRM idempotency key')
    if (request.content.kind === 'template' || request.content.kind === 'interactive') throw new WhatsAppTransportError('unsupported_capability', 'OpenWA transport does not implement Meta templates or interactive payloads')

    const result = request.content.kind === 'text'
      ? await this.client.sendText({ sessionId: this.sessionId, to: request.recipient, text: request.content.text, replyToProviderMessageId: request.replyToProviderMessageId, idempotencyKey: request.idempotencyKey }, request.idempotencyKey)
      : await this.client.sendMedia({ sessionId: this.sessionId, to: request.recipient, kind: request.content.mediaKind, link: request.content.link, caption: request.content.caption, filename: request.content.filename, replyToProviderMessageId: request.replyToProviderMessageId, idempotencyKey: request.idempotencyKey }, request.idempotencyKey)

    return { provider: 'openwa', connectionId: this.connectionId, providerMessageId: result.providerMessageId, providerMetadata: result.raw }
  }
}

export async function resolveOpenWATransport(db: SupabaseClient, accountId: string, connectionId: string): Promise<ResolvedOpenWATransport> {
  const { data, error } = await db.from('whatsapp_connections').select('id, account_id, provider, status, session_id').eq('id', connectionId).eq('account_id', accountId).eq('provider', 'openwa').maybeSingle()
  if (error || !data) throw new WhatsAppTransportError('authentication_or_configuration', 'OpenWA connection is not configured for this account', error)
  const connection = data as OpenWAConnectionRow
  if (connection.status !== 'connected' && connection.status !== 'ready') throw new WhatsAppTransportError('connection_restricted', `OpenWA connection is not ready (${connection.status})`)
  if (!connection.session_id) throw new WhatsAppTransportError('authentication_or_configuration', 'OpenWA connection has no session identity')
  const { client } = await resolveOpenWAClient(db, accountId, connectionId)
  return { connectionId, transport: new OpenWAWhatsAppTransport(accountId, connectionId, connection.session_id, client) }
}
