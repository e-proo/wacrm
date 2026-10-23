import type { SupabaseClient } from '@supabase/supabase-js'

import type { MessageTemplate } from '@/types'
import { resolveMetaTransport } from '@/lib/whatsapp/transport/meta-adapter'

export interface BroadcastTransportSendInput {
  accountId: string
  connectionId: string
  recipient: string
  templateName: string
  language: string
  template: MessageTemplate | null
  params: string[]
}

/** Send one broadcast recipient through the account-scoped Meta transport boundary. */
export async function sendBroadcastTemplate(
  db: SupabaseClient,
  input: BroadcastTransportSendInput,
): Promise<string> {
  const resolved = await resolveMetaTransport(db, input.accountId)
  if (resolved.connectionId !== input.connectionId) {
    throw new Error('WHATSAPP_CONNECTION_CHANGED_AFTER_BROADCAST_PLAN')
  }

  const result = await resolved.transport.send({
    accountId: input.accountId,
    connectionId: input.connectionId,
    recipient: input.recipient,
    content: {
      kind: 'template',
      templateName: input.templateName,
      language: input.language,
      template: input.template ?? undefined,
      params: input.params,
    },
  })
  return result.providerMessageId
}
