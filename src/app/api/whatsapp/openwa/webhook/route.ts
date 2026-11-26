import { NextResponse } from 'next/server'
import { classifyOpenWAWebhookRejection,verifyAndReserveOpenWAWebhook } from '@/lib/whatsapp/transport/openwa/webhook'
import { createOpenWAWebhookDb,processReservedOpenWAWebhook } from '@/lib/whatsapp/transport/openwa/webhook-processing'
import { durableOpenWAIntakeEnabled,readDurableWebhookBody,DurableIntakeBodyTooLarge } from '@/lib/whatsapp/transport/openwa/durable-intake'
import { canonicalInboxTestMode } from '@/lib/inbox/canonical-ingress'
export const maxDuration=60
export async function POST(request: Request) {
  const started=performance.now()
  const durable=durableOpenWAIntakeEnabled()
  let rawBody:string
  try{rawBody=durable?await readDurableWebhookBody(request):await request.text()}catch(error){
    return NextResponse.json({error:'OpenWA webhook body rejected',code:error instanceof DurableIntakeBodyTooLarge?'body_too_large':'invalid_payload'},{status:error instanceof DurableIntakeBodyTooLarge?413:400,headers:{'Cache-Control':'no-store'}})
  }
  const signature = request.headers.get('x-openwa-signature')
  let reservation
  try {
    reservation = await verifyAndReserveOpenWAWebhook(createOpenWAWebhookDb(), { rawBody, signature, ...(durable?{durableMode:canonicalInboxTestMode()}: {}) })
  } catch (error) {
    // A missing/busy receipt store is NOT an invalid signed event: ask the
    // gateway to retry the SAME idempotent delivery after a short delay.
    // Never echo arbitrary DB/provider exception messages to the caller.
    const reason = classifyOpenWAWebhookRejection(error)
    const retryable = new Set([
      'receipt_reservation_failed',
      'unexpected_error',
      'server_db_configuration_missing',
      'missing_webhook_secret',
      'missing_credentials',
      'credential_decryption_failed',
      'credential_scope_mismatch',
    ]).has(reason)
    const status = reason === 'body_too_large' ? 413 : reason === 'event_identity_conflict' ? 409 : reason === 'invalid_signature' ? 401
      : reason === 'unknown_session' ? 404
        : retryable ? 503 : 400
    const clientCode = retryable ? 'intake_unavailable' : reason
    console.warn('[openwa-webhook] intake rejected', { status, reason })
    return NextResponse.json({
      error: 'OpenWA webhook intake rejected',
      code: clientCode,
    }, {
      status,
      headers: retryable
        ? { 'Retry-After': '5', 'Cache-Control': 'no-store' }
        : { 'Cache-Control': 'no-store' },
    })
  }
  if (reservation.queued) return NextResponse.json({ok:true,queued:true,duplicate:reservation.queueDuplicate===true},{status:202,headers:{'Cache-Control':'no-store','Server-Timing':'durable-intake;dur='+Math.round(performance.now()-started)}})
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
  // Synchronous mode still acknowledges only after processing. Durable mode
  // acknowledged only after the atomic receipt+encrypted payload commit above.
  return processReservedOpenWAWebhook(createOpenWAWebhookDb(),{accountId,connectionId,envelope,processingToken},canonicalInboxTestMode())
}
