/** Admin-only read/triage surface for durable OpenWA recovery. TEST mutations only. */
import { NextResponse } from 'next/server'
import { requireOpenWASessionAdmin } from '@/lib/whatsapp/transport/openwa/session-auth'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'
import { resolveOpenWAClient } from '@/lib/whatsapp/transport/openwa/credentials'

type Context = { params: Promise<{ connectionId: string }> }
const noStore = { 'Cache-Control': 'private, no-store, max-age=0' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function scoped(requestContext: Context) {
  const { connectionId } = await requestContext.params
  if (!UUID.test(connectionId)) return null
  const { accountId, adminDb } = await requireOpenWASessionAdmin()
  const { data: connection, error } = await adminDb.from('whatsapp_connections')
    .select('id').eq('account_id', accountId).eq('id', connectionId)
    .eq('provider', 'openwa').is('archived_at', null).maybeSingle()
  if (error || !connection) return null
  return { accountId, connectionId, db: adminDb }
}

export async function GET(_request: Request, context: Context) {
  try {
    const state = await scoped(context)
    if (!state) return NextResponse.json({ error: 'OpenWA connection not found' }, { status: 404, headers: noStore })
    const { data, error } = await state.db.from('openwa_deferred_events')
      .select('id,event_kind,state,attempt_count,last_error_code,created_at,updated_at')
      .eq('account_id', state.accountId).eq('connection_id', state.connectionId)
      .order('created_at', { ascending: false }).limit(50)
    if (error) throw new Error('Deferred diagnostics unavailable')
    // No phone, LID, message body, gateway URL, bearer or raw status receipt
    // is returned to the admin browser.
    const entries = data ?? []
    const counts: Record<string, number> = {}
    const { data: countsRows, error: countError } = await state.db.from('openwa_deferred_events')
      .select('event_kind,state').eq('account_id', state.accountId)
      .eq('connection_id', state.connectionId).limit(5000)
    if (countError) throw new Error('Deferred diagnostics unavailable')
    for (const item of countsRows ?? []) {
      const key = item.event_kind + ':' + item.state
      counts[key] = (counts[key] ?? 0) + 1
    }
    return NextResponse.json({
      counts, sample: entries, sample_limit: 50, count_limit: 5000,
      may_retry: isOpenWATestProject(),
    }, { headers: noStore })
  } catch {
    return NextResponse.json({ error: 'OpenWA diagnostics require session-admin access' }, { status: 403, headers: noStore })
  }
}

export async function POST(request: Request, context: Context) {
  if (!isOpenWATestProject()) {
    return NextResponse.json({ error: 'TEST only' }, { status: 403, headers: noStore })
  }
  try {
    const state = await scoped(context)
    if (!state) return NextResponse.json({ error: 'OpenWA connection not found' }, { status: 404, headers: noStore })
    const body = await request.json() as Record<string, unknown>
    if (body.action === 'verify_phone' && typeof body.job_id === 'string' &&
        UUID.test(body.job_id) && typeof body.phone === 'string') {
      const phone = body.phone.trim().replace(/^\+/, '')
      if (!/^[1-9][0-9]{6,14}$/.test(phone)) {
        return NextResponse.json({ error: 'Invalid international phone number' }, { status: 400, headers: noStore })
      }
      const { data: job, error: jobError } = await state.db.from('openwa_deferred_events')
        .select('id,event_kind,native_chat_id,session_id,own_phone_identity,instance_id')
        .eq('account_id', state.accountId).eq('connection_id', state.connectionId)
        .eq('id', body.job_id).eq('event_kind', 'unresolved_identity')
        .eq('state', 'review').maybeSingle()
      if (jobError || !job || !job.native_chat_id || !/^[0-9]{5,20}@lid$/.test(job.native_chat_id)) {
        return NextResponse.json({ error: 'Unresolved identity not available for verification' }, { status: 409, headers: noStore })
      }
      if (phone === job.native_chat_id.slice(0, -4)) {
        return NextResponse.json({ error: 'A privacy LID is not a phone number' }, { status: 409, headers: noStore })
      }
      const { data: connection, error: ce } = await state.db.from('whatsapp_connections')
        .select('session_id,phone_identity,instance_id,status')
        .eq('id', state.connectionId).eq('account_id', state.accountId)
        .eq('provider', 'openwa').is('archived_at', null).maybeSingle()
      if (ce || !connection || !['ready','connected'].includes(connection.status) ||
          connection.session_id !== job.session_id ||
          connection.phone_identity !== job.own_phone_identity ||
          connection.instance_id !== job.instance_id) {
        return NextResponse.json({ error: 'Original OpenWA session is not ready or has changed' },
          { status: 409, headers: noStore })
      }
      // Ask the SAME linked session to prove the phone -> native LID
      // relationship. Admin knowledge alone is NOT identity proof.
      const { client } = await resolveOpenWAClient(state.db, state.accountId, state.connectionId, { timeoutMs: 7000 })
      const result = await client.request<unknown>(
        `/api/sessions/${encodeURIComponent(job.session_id)}/contacts/${encodeURIComponent(phone)}/lid`,
        { timeoutMs: 7000 },
      )
      const candidate = result && typeof result === 'object' && !Array.isArray(result)
        ? (result as Record<string, unknown>).lid : null
      if (candidate !== job.native_chat_id) {
        return NextResponse.json({ error: 'OpenWA could not verify this exact phone-to-LID binding' },
          { status: 409, headers: noStore })
      }
      const now = new Date().toISOString()
      const { data: updated, error: ue } = await state.db.from('openwa_deferred_events')
        .update({
          verified_phone: phone, verification_source: 'openwa_reverse_lid',
          verified_at: now, state: 'pending', next_attempt_at: now,
          last_error_code: null, updated_at: now,
        })
        .eq('account_id', state.accountId).eq('connection_id', state.connectionId)
        .eq('id', job.id).eq('state', 'review')
        .select('id').maybeSingle()
      if (ue || !updated) {
        return NextResponse.json({ error: 'Provider verification succeeded but the review state changed' },
          { status: 409, headers: noStore })
      }
      return NextResponse.json({ verified: true, queued: true }, { headers: noStore })
    }
    if (body.action !== 'retry_review' || typeof body.job_id !== 'string' || !UUID.test(body.job_id)) {
      return NextResponse.json({ error: 'Invalid reconciliation request' }, { status: 400, headers: noStore })
    }
    // A review item is only re-queued after an authenticated operator action.
    // The worker still requires native identity proof; retries NEVER send WhatsApp.
    const { data: changed, error } = await state.db.from('openwa_deferred_events')
      .update({ state: 'pending', next_attempt_at: new Date().toISOString(), last_error_code: null, updated_at: new Date().toISOString() })
      .eq('account_id', state.accountId).eq('connection_id', state.connectionId)
      .eq('id', body.job_id).eq('state', 'review').select('id').maybeSingle()
    if (error || !changed) return NextResponse.json({
      error: 'Deferred item was not in review or could not be re-queued',
    }, { status: 409, headers: noStore })
    return NextResponse.json({ queued: true }, { headers: noStore })
  } catch {
    return NextResponse.json({ error: 'OpenWA reconciliation requires session-admin access' }, { status: 403, headers: noStore })
  }
}
