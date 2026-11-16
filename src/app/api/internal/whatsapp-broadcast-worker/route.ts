/** Authenticated bounded TEST-only durable broadcast worker tick. */
import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'
import { processBroadcastDeliveryTick } from '@/lib/whatsapp/broadcast-worker'

export const runtime = 'nodejs'
export const maxDuration = 120
const headers = { 'Cache-Control': 'private, no-store' }
function authorized(value: string | null, secret: string): boolean {
  const expected = Buffer.from('Bearer ' + secret)
  const actual = Buffer.from(value ?? '')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
export async function POST(request: Request) {
  // Intentional fail-closed rollout gate: Production delivery needs a
  // separately approved scheduler and live-acceptance evidence.
  if (!isOpenWATestProject()) return NextResponse.json({ error: 'TEST only' }, { status: 403, headers })
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({ error: 'Worker secret not configured' }, { status: 503, headers })
  if (!authorized(request.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })
  }
  try {
    const result = await processBroadcastDeliveryTick('test-broadcast:' + crypto.randomUUID())
    return NextResponse.json(result, { headers })
  } catch (error) {
    console.error('[TEST broadcast worker] tick failed', error)
    return NextResponse.json({ error: 'Broadcast worker failed' }, { status: 500, headers })
  }
}
