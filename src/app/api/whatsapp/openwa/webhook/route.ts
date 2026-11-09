import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

import { normalizeOpenWAInboundMessage, normalizeOpenWAOwnSentMessage } from '@/lib/whatsapp/inbound-normalization'
import { processOpenWAOwnSentEcho } from '@/lib/whatsapp/transport/openwa/outbound-echo'
import { extractOpenWASignedInlineMedia } from '@/lib/whatsapp/transport/openwa/webhook-media'
import { processNormalizedInboundMessage } from '@/lib/whatsapp/inbound-processor'
import { applyOpenWAStatusWithRetry, parseOpenWAStatusEvent } from '@/lib/whatsapp/status-lifecycle'
import { classifyOpenWAWebhookRejection, markOpenWAWebhookProcessed, verifyAndReserveOpenWAWebhook } from '@/lib/whatsapp/transport/openwa/webhook'
import { refreshOpenWAConnectionStatus } from '@/lib/whatsapp/transport/openwa/session-lifecycle'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

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
  // Concurrent delivery cannot be acknowledged before its existing handler
  // completes. Non-2xx asks the gateway to retry with the SAME signed event,
  // never to send a new WhatsApp message.
  if (reservation.inFlight) {
    return NextResponse.json({ error: 'OpenWA webhook processing in progress', code: 'in_flight' }, {
      status: 503, headers: { 'Retry-After': '5', 'Cache-Control': 'no-store' },
    })
  }
  const { accountId, connectionId, envelope, processingToken } = reservation
  if (!processingToken) {
    return NextResponse.json({ error: 'OpenWA webhook lease unavailable' }, {
      status: 503, headers: { 'Retry-After': '5' },
    })
  }

  // Await business processing BEFORE returning 2xx. An after() callback
  // can be aborted after a 202 is already sent; the gateway then assumes
  // delivery even though the receipt is still unfinished. Here failures
  // return 503 and an expired lease can be resumed on signed redelivery.
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
    await markOpenWAWebhookProcessed(db, accountId, connectionId, envelope.eventId, processingToken)
    return NextResponse.json({ ok: true }, { status: 202 })
  } catch (error) {
    // Never persist or log arbitrary upstream error messages, provider
    // payloads or credentials. A failed attempt remains recoverable.
    const code = error instanceof WhatsAppTransportError
      ? error.code : error instanceof Error && error.name === 'AbortError'
        ? 'aborted' : 'processing_failed'
    try {
      await markOpenWAWebhookProcessed(adminDb(), accountId, connectionId, envelope.eventId, processingToken, code)
    } catch {
      console.error('[openwa-webhook] could not release processing lease', { connectionId })
    }
    console.warn('[openwa-webhook] delivery deferred for signed retry', { connectionId, event: envelope.event, code })
    return NextResponse.json({ error: 'OpenWA webhook processing deferred', code: 'processing_retry' }, {
      status: 503, headers: { 'Retry-After': '5', 'Cache-Control': 'no-store' },
    })
  }
}
