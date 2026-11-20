/**
 * TEST-only on-demand read-only OpenWA native message archive evidence.
 * No queue settlement, status mutation, send, native ID, PII or credential
 * is returned. Stronger than a local ID match; still not delivery proof.
 */
import { NextResponse } from 'next/server'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'
import { requireOpenWASessionAdmin } from '@/lib/whatsapp/transport/openwa/session-auth'
import { safeEvidence } from '@/lib/whatsapp/transport/openwa/native-ack-evidence'
import { inspectOpenWANativeAck } from '@/lib/whatsapp/transport/openwa/native-ack-provider'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store, max-age=0' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type Context = { params: Promise<{ connectionId: string; jobId: string }> }

export async function GET(_request: Request, context: Context) {
  if (!isOpenWATestProject()) {
    return NextResponse.json({ error: 'TEST only' }, {status:403,headers})
  }
  const { connectionId, jobId } = await context.params
  if (!UUID.test(connectionId) || !UUID.test(jobId)) {
    return NextResponse.json({error:'Invalid request'}, {status:400,headers})
  }

  let scope: Awaited<ReturnType<typeof requireOpenWASessionAdmin>>
  try {
    scope = await requireOpenWASessionAdmin()
  } catch {
    return NextResponse.json({error:'Session-admin access required'}, {status:403,headers})
  }

  try {
    const { accountId, adminDb: db } = scope
    const [connectionResult, jobResult] = await Promise.all([
      db.from('whatsapp_connections')
        .select('id,session_id,phone_identity,instance_id,status')
        .eq('account_id', accountId).eq('id',connectionId)
        .eq('provider','openwa').is('archived_at',null).maybeSingle(),
      db.from('openwa_deferred_events')
        .select('id,session_id,own_phone_identity,instance_id,provider_message_id,event_kind,state')
        .eq('account_id',accountId).eq('connection_id',connectionId)
        .eq('id',jobId).eq('event_kind','unmatched_status')
        .in('state',['pending','review']).maybeSingle(),
    ])
    if (connectionResult.error || jobResult.error) {
      throw new Error('scoped_read_unavailable')
    }
    const connection = connectionResult.data
    const job = jobResult.data
    if (!connection || !job) {
      return NextResponse.json({error:'Connection or pending ACK not found'}, {status:404,headers})
    }
    const evidence = await inspectOpenWANativeAck(
      db, accountId, connectionId, connection, job,
    )
    const resultStatus = evidence.code === 'session_identity_unverified' ? 409
      : evidence.code === 'native_reference_unsupported' ? 422 : 200
    return NextResponse.json(evidence,{status:resultStatus,headers})
  } catch {
    // No raw upstream error/URL, message, token, sender or native ID in JSON/logs.
    return NextResponse.json(safeEvidence('gateway_unavailable'),{status:503,headers})
  }
}
