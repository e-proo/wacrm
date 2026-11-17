/** TEST-only, authenticated signed-OpenWA deferred identity/ACK recovery tick. */
import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'
import { processOpenWADeferredTick } from '@/lib/whatsapp/transport/openwa/deferred-worker'

export const runtime = 'nodejs'
export const maxDuration = 120
const headers = { 'Cache-Control': 'private, no-store' }
function authorized(auth: string | null, secret: string): boolean {
  const actual = Buffer.from(auth ?? '')
  const expected = Buffer.from('Bearer ' + secret)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
export async function POST(request: Request) {
  if (!isOpenWATestProject()) {
    return NextResponse.json({ error: 'TEST only' }, { status: 403, headers })
  }
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Worker secret not configured' }, { status: 503, headers })
  }
  if (!authorized(request.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })
  }
  try {
    return NextResponse.json(await processOpenWADeferredTick(), { headers })
  } catch {
    console.error('[openwa-deferred-worker] tick failed')
    return NextResponse.json({ error: 'Deferred reconciliation failed' }, { status: 500, headers })
  }
}
