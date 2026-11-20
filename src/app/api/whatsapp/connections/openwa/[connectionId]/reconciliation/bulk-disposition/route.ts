/**
 * OW14-W05: explicitly-selected, bounded ACK batch disposition on TEST.
 * Every item passes the existing tenant/actor-scoped, row-locked SQL RPC.
 *
 * This never sends/retries messages, edits message delivery state, or infers
 * delivery from a missing native archive record. A partial batch is reported
 * accurately: no fabricated all-or-nothing outcome.
 */
import { NextResponse } from 'next/server'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'
import { requireOpenWASessionAdmin } from '@/lib/whatsapp/transport/openwa/session-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const noStore = { 'Cache-Control': 'private, no-store, max-age=0' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BATCH = 25
type Context = { params: Promise<{ connectionId: string }> }

const SAFE_REASONS = new Set([
  'local_match_requires_reconciliation',
  'not_eligible_or_already_closed',
  'actor_forbidden',
  'connection_scope_mismatch',
  'invalid_request',
])

type CloseResult = {
  job_id: string
  result: 'closed_unverified' | 'not_closed'
  reason?: string
}

export async function POST(request: Request, context: Context) {
  if (!isOpenWATestProject()) {
    return NextResponse.json({ error: 'TEST only' }, { status: 403, headers: noStore })
  }
  const { connectionId } = await context.params
  if (!UUID.test(connectionId)) {
    return NextResponse.json({ error: 'Invalid connection' }, { status: 400, headers: noStore })
  }

  let scope: Awaited<ReturnType<typeof requireOpenWASessionAdmin>>
  try {
    scope = await requireOpenWASessionAdmin()
  } catch {
    return NextResponse.json({ error: 'Session-admin access required' }, { status: 403, headers: noStore })
  }

  let jobIds: string[]
  try {
    const body: unknown = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('Invalid object')
    const value = body as Record<string, unknown>
    if (value.action !== 'close_selected_unverified' || value.confirm_no_resend !== true ||
        !Array.isArray(value.job_ids) ||
        value.job_ids.length < 1 || value.job_ids.length > MAX_BATCH ||
        !value.job_ids.every((id): id is string => typeof id === 'string' && UUID.test(id))) {
      throw Error('Invalid batch')
    }
    jobIds = value.job_ids as string[]
    if (new Set(jobIds.map(id => id.toLowerCase())).size !== jobIds.length) {
      throw Error('Duplicate IDs')
    }
  } catch {
    return NextResponse.json({ error: 'Invalid or unconfirmed ACK selection' },
      { status: 400, headers: noStore })
  }

  // Limited concurrency: independent row-locked RPCs; distinct job IDs only.
  // One stale/matched/leased job does NOT mask the outcomes of other jobs.
  const { adminDb, accountId, user } = scope
  const results: CloseResult[] = []
  for (let i = 0; i < jobIds.length; i += 5) {
    const group = await Promise.all(jobIds.slice(i, i + 5).map(async (jobId: string): Promise<CloseResult> => {
      try {
        const { data, error } = await adminDb.rpc('close_openwa_unmatched_ack', {
          p_account_id: accountId,
          p_connection_id: connectionId,
          p_job_id: jobId,
          p_actor: user.id,
          p_finding: 'no_verified_evidence',
          p_gateway_status: null,
          p_confirm_no_resend: true,
        })
        if (error) return { job_id: jobId, result: 'not_closed', reason: 'temporary_error' }
        if (data?.updated === true && data.disposition === 'closed_unverified') {
          return { job_id: jobId, result: 'closed_unverified' }
        }
        const reason = typeof data?.reason === 'string' && SAFE_REASONS.has(data.reason)
          ? data.reason : 'not_eligible'
        return { job_id: jobId, result: 'not_closed', reason }
      } catch {
        return { job_id: jobId, result: 'not_closed', reason: 'temporary_error' }
      }
    }))
    results.push(...group)
  }
  const closed = results.filter(item => item.result === 'closed_unverified').length
  return NextResponse.json({
    requested: jobIds.length,
    closed,
    not_closed: jobIds.length - closed,
    results,
    delivery_confirmed: false,
    outbound_resent: false,
  }, { headers: noStore })
}
