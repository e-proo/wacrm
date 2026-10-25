import { after, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

import {
  markOpenWAWebhookProcessed,
  verifyAndReserveOpenWAWebhook,
} from '@/lib/whatsapp/transport/openwa/webhook'

export const maxDuration = 60

function adminDb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) throw new Error('Server database credentials are not configured')
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-openwa-signature')
  const timestamp = request.headers.get('x-openwa-timestamp')

  let reservation
  try {
    reservation = await verifyAndReserveOpenWAWebhook(adminDb(), {
      rawBody,
      signature,
      timestamp,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid OpenWA webhook'
    const status = message.includes('signature') ? 401 : message.includes('Unknown') ? 404 : 400
    return NextResponse.json({ error: message }, { status })
  }

  if (reservation.duplicate) {
    return NextResponse.json({ ok: true, duplicate: true })
  }

  const { connectionId, envelope } = reservation
  after(async () => {
    try {
      // OW-5 owns authenticated intake + durable dedup only. OW-6 will route
      // accepted envelopes into the shared normalized inbound business path.
      await markOpenWAWebhookProcessed(adminDb(), connectionId, envelope.eventId)
    } catch (error) {
      const safeMessage = error instanceof Error ? error.message : 'OpenWA webhook processing failed'
      try {
        await markOpenWAWebhookProcessed(adminDb(), connectionId, envelope.eventId, safeMessage)
      } catch {
        console.error('[openwa-webhook] failed to finalize receipt', { connectionId, eventId: envelope.eventId })
      }
    }
  })

  return NextResponse.json({ ok: true }, { status: 202 })
}
