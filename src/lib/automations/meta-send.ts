/** Compatibility facade: all automated/agent sends use the same durable outbound core as manual/API sends. */
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { engineSendInteractiveButtons, engineSendInteractiveList } from '@/lib/flows/meta-send'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { canonicalInboxTestMode } from '@/lib/inbox/canonical-ingress'
import { getCanonicalAgentRunRoute } from '@/lib/inbox/canonical-route-context'
import { resolveConversationTransport } from '@/lib/whatsapp/transport/router'
import { WhatsAppTransportError, type WhatsAppProvider, type WhatsAppSendWorkload } from '@/lib/whatsapp/transport/types'
import { supabaseAdmin } from './admin-client'

interface SendTextArgs {
  accountId: string; userId: string; conversationId: string; contactId: string; text: string
  aiAgentRunId?: string; engineIdempotencyKey?: string; workload?: WhatsAppSendWorkload
  connectionId?: string; expectedProvider?: WhatsAppProvider
}
interface SendTemplateArgs {
  accountId: string; userId: string; conversationId: string; contactId: string; templateName: string
  language?: string; params?: string[]; engineIdempotencyKey?: string; workload?: WhatsAppSendWorkload
  connectionId?: string; expectedProvider?: WhatsAppProvider
}
type SendInput = (SendTextArgs & { kind: 'text' }) | (SendTemplateArgs & { kind: 'template' })

async function sendViaTransport(input: SendInput): Promise<{ whatsapp_message_id: string; local_message_id: string }> {
  const db = supabaseAdmin()
  const causalConnection = canonicalInboxTestMode() && input.kind === 'text' && input.aiAgentRunId
    ? await getCanonicalAgentRunRoute(db,input.accountId,input.conversationId,input.aiAgentRunId,input.connectionId)
    : input.connectionId
  const resolved = await resolveConversationTransport(db, input.accountId, input.conversationId, causalConnection)
  // Agent Task reservations freeze a tenant-scoped provider and connection. Never silently fail over.
  if (input.connectionId) {
    const { data: bound, error } = await db.from('whatsapp_connections')
      .select('id, provider, status, archived_at').eq('account_id', input.accountId)
      .eq('id', input.connectionId).maybeSingle()
    if (error || !bound || bound.archived_at || bound.provider !== input.expectedProvider ||
      !(bound.provider === 'meta_cloud' ? bound.status === 'connected' : (bound.status === 'connected' || bound.status === 'ready')) ||
      resolved.connectionId !== bound.id || resolved.transport.provider !== bound.provider) {
      throw new WhatsAppTransportError('connection_restricted', 'Frozen Agent Task WhatsApp connection is missing, changed or not ready')
    }
  }
  if (input.kind === 'template' && resolved.transport.provider !== 'meta_cloud') {
    throw new WhatsAppTransportError('unsupported_capability', 'OpenWA does not use Meta approved-template policy')
  }
  const engineKey = input.engineIdempotencyKey
  const sent = await sendMessageToConversation(db, input.accountId, {
    conversationId: input.conversationId,
    expectedContactId: input.contactId,
    connectionId: resolved.connectionId,
    messageType: input.kind,
    contentText: input.kind === 'text' ? input.text : undefined,
    templateName: input.kind === 'template' ? input.templateName : undefined,
    templateLanguage: input.kind === 'template' ? input.language : undefined,
    templateParams: input.kind === 'template' ? input.params : undefined,
    idempotencyKey: engineKey ?? (input.kind === 'text' ? input.aiAgentRunId : undefined),
    engineIdempotencyKey: engineKey,
    aiAgentRunId: input.kind === 'text' ? input.aiAgentRunId : undefined,
    senderType: 'bot',
    preservePreDispatchError: true,
    pauseActiveFlows: false,
    workload: input.workload ?? (input.kind === 'text' && input.aiAgentRunId ? 'agent' : 'automation'),
  })
  return { whatsapp_message_id: sent.whatsappMessageId, local_message_id: sent.messageId }
}
export async function engineSendText(input: SendTextArgs): Promise<{ whatsapp_message_id: string; local_message_id: string }> {
  return sendViaTransport({ ...input, kind: 'text' })
}
export async function engineSendTemplate(input: SendTemplateArgs): Promise<{ whatsapp_message_id: string }> {
  return sendViaTransport({ ...input, kind: 'template' })
}
interface SendInteractiveArgs {
  accountId: string; userId: string; conversationId: string; contactId: string
  payload: InteractiveMessagePayload; engineIdempotencyKey?: string
}
export async function engineSendInteractive(input: SendInteractiveArgs): Promise<{ whatsapp_message_id: string }> {
  const common = {
    accountId: input.accountId, userId: input.userId, conversationId: input.conversationId,
    contactId: input.contactId, engineIdempotencyKey: input.engineIdempotencyKey,
  }
  const payload = input.payload
  return payload.kind === 'buttons'
    ? engineSendInteractiveButtons({ ...common, bodyText: payload.body, headerText: payload.header, footerText: payload.footer, buttons: payload.buttons })
    : engineSendInteractiveList({ ...common, bodyText: payload.body, buttonLabel: payload.button_label, headerText: payload.header, footerText: payload.footer, sections: payload.sections })
}
