import { after, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

import { normalizeOpenWAInboundMessage, normalizeOpenWAOwnSentMessage } from '@/lib/whatsapp/inbound-normalization'
import { processOpenWAOwnSentEcho } from '@/lib/whatsapp/transport/openwa/outbound-echo'
import { extractOpenWASignedInlineMedia } from '@/lib/whatsapp/transport/openwa/webhook-media'
import { processNormalizedInboundMessage } from '@/lib/whatsapp/inbound-processor'
import { applyOpenWAStatusWithRetry, parseOpenWAStatusEvent } from '@/lib/whatsapp/status-lifecycle'
import { classifyOpenWAWebhookRejection, markOpenWAWebhookProcessed, verifyAndReserveOpenWAWebhook } from '@/lib/whatsapp/transport/openwa/webhook'
import { refreshOpenWAConnectionStatus } from '@/lib/whatsapp/transport/openwa/session-lifecycle'

export const maxDuration = 60
function adminDb() { const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY; if (!url || !serviceKey) throw new Error('Server database credentials are not configured'); return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }) }

export async function POST(request: Request) {
  const rawBody = await request.text(); const signature = request.headers.get('x-openwa-signature')
  let reservation
  try {
    reservation = await verifyAndReserveOpenWAWebhook(adminDb(), { rawBody, signature })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid OpenWA webhook'
    const status = message.includes('signature') ? 401 : message.includes('Unknown') ? 404 : 400
    // Log only a fixed reason code. Never log webhook bodies, HMAC values, credentials, or untrusted errors.
    console.warn('[openwa-webhook] intake rejected', {
      status,
      reason: classifyOpenWAWebhookRejection(error),
    })
    return NextResponse.json({ error: message }, { status })
  }
  if (reservation.duplicate) return NextResponse.json({ ok: true, duplicate: true })
  const { accountId, connectionId, envelope } = reservation
  after(async () => {
    try {
      const db = adminDb()
      const event = envelope.event.toLowerCase().replace(/[\s_-]+/g, '.')
      if (['session.status', 'session.authenticated', 'session.disconnected', 'session.restriction'].includes(event)) {
        await refreshOpenWAConnectionStatus(db, accountId, connectionId)
      } else if (['status', 'message.status', 'message.ack', 'message.receipt', 'message.failed', 'ack', 'delivery', 'receipt'].includes(event)) {
        const status = parseOpenWAStatusEvent(envelope.data)
        if (status) {
          const result = await applyOpenWAStatusWithRetry(db, { provider: 'openwa', accountId, connectionId, ...status })
          if (result === 'unknown') {
            // No provider payload, recipient or message contents in logs.
            // Long-running ambiguous sends must be reconciled, not resent.
            console.warn('[openwa-webhook] unmatched delivery receipt', { connectionId, status: status.status })
          }
        } else {
          console.warn('[openwa-webhook] unrecognized delivery receipt', { connectionId, event })
        }
      } else if (event === 'message.sent') {
        const ownSent = normalizeOpenWAOwnSentMessage(envelope, connectionId)
        if (ownSent) {
          const { data: account, error: accountError } = await db.from('accounts')
            .select('owner_user_id').eq('id', accountId).maybeSingle()
          if (accountError || !account?.owner_user_id) throw new Error('OpenWA account owner could not be resolved')
          await processOpenWAOwnSentEcho({
            db, storage: db.storage, accountId, connectionId,
            ownerUserId: account.owner_user_id, message: ownSent,
            signedInlineMedia: extractOpenWASignedInlineMedia(envelope),
          })
        }
      } else {
        const normalized = normalizeOpenWAInboundMessage(envelope, connectionId)
        if (normalized) {
          const { data: account, error: accountError } = await db.from('accounts').select('owner_user_id').eq('id', accountId).maybeSingle()
          if (accountError || !account?.owner_user_id) throw new Error('OpenWA account owner could not be resolved')
          await processNormalizedInboundMessage(normalized.message, normalized.contact, accountId, connectionId, account.owner_user_id, '', true, extractOpenWASignedInlineMedia(envelope))
        }
      }
      await markOpenWAWebhookProcessed(db, connectionId, envelope.eventId)
    } catch (error) {
      const safeMessage = error instanceof Error ? error.message : 'OpenWA webhook processing failed'
      try { await markOpenWAWebhookProcessed(adminDb(), connectionId, envelope.eventId, safeMessage) } catch { console.error('[openwa-webhook] failed to finalize receipt', { connectionId, eventId: envelope.eventId }) }
    }
  })
  return NextResponse.json({ ok: true }, { status: 202 })
}
