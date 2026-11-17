import type { SupabaseClient } from '@supabase/supabase-js'

import type { NormalizedInbound } from '@/lib/whatsapp/inbound-normalization'
import { resolveOpenWAClient } from './credentials'

const PHONE = /^[1-9][0-9]{6,14}$/
const LID = /^[0-9]{5,20}@lid$/

/**
 * On-demand fallback when the gateway webhook does not contain senderPhone.
 * The request is scoped to the authenticated, HMAC-verified event's own
 * account/connection/session. An @lid is never itself a telephone number.
 *
 * A null phone leaves the inbound identity unresolved and does not authorize
 * CRM contact creation. Transport errors are retryable by the signed webhook
 * intake, not by sending a WhatsApp message.
 */
export async function hydrateOpenWAInboundSenderPhone(
  db: SupabaseClient,
  input: {
    accountId: string
    connectionId: string
    sessionId: string
    inbound: NormalizedInbound
  },
): Promise<boolean> {
  const { accountId, connectionId, sessionId, inbound } = input
  const chat = inbound.message.providerChatId
  if (!chat || !LID.test(chat)) return false
  const lidDigits = chat.slice(0, -4)
  // A real distinct senderPhone already won at normalization. Never
  // overwrite it with an on-demand lookup, which can be stale.
  if (PHONE.test(inbound.message.from) && inbound.message.from !== lidDigits) return false
  if (inbound.message.from !== chat && inbound.message.from !== lidDigits) return false
  const { client } = await resolveOpenWAClient(db, accountId, connectionId, { timeoutMs: 5_000 })
  const answer = await client.request<unknown>(
    `/api/sessions/${encodeURIComponent(sessionId)}/contacts/${encodeURIComponent(chat)}/phone`,
    { timeoutMs: 5_000 },
  )
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false
  const supplied = (answer as Record<string, unknown>).phone
  const phone = typeof supplied === 'string' ? supplied.replace(/^\+/, '') : ''
  if (!PHONE.test(phone) || phone === lidDigits) return false

  inbound.message.from = phone
  inbound.contact.wa_id = phone
  return true
}
