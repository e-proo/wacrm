/** Session-admin-only TEST operator acknowledgement of ambiguous outbound sends.
 * This NEVER marks delivered/failed, contacts OpenWA, or retries messages.
 */
import { NextResponse } from 'next/server'
import { requireOpenWASessionAdmin } from '@/lib/whatsapp/transport/openwa/session-auth'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'

export const runtime = 'nodejs'
const noStore = { 'Cache-Control': 'private, no-store, max-age=0' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type Context = { params: Promise<{ connectionId: string }> }
type ReviewFinding = 'seen_on_whatsapp' | 'not_seen_on_whatsapp' | 'still_uncertain'

function deny(error: string, status: number, code: string) {
  return NextResponse.json({ error, code }, { status, headers: noStore })
}

export async function GET(_request: Request, context: Context) {
  if (!isOpenWATestProject()) return deny('TEST only', 403, 'test_only')
  try {
    const { connectionId } = await context.params
    if (!UUID.test(connectionId)) return deny('Invalid connection ID', 400, 'invalid_connection')
    const { accountId, adminDb } = await requireOpenWASessionAdmin()
    const { data, error } = await adminDb.rpc('get_openwa_outbound_review_queue', {
      p_account_id: accountId, p_connection_id: connectionId,
    })
    if (error) return deny('Unable to load outbound review queue', 502, 'review_unavailable')
    if (!data) return deny('OpenWA session not found', 404, 'connection_not_found')
    return NextResponse.json(data, { headers: noStore })
  } catch {
    return deny('Session-admin access required', 403, 'unauthorized')
  }
}

export async function POST(request: Request, context: Context) {
  if (!isOpenWATestProject()) return deny('TEST only', 403, 'test_only')
  try {
    const { connectionId } = await context.params
    if (!UUID.test(connectionId)) return deny('Invalid connection ID', 400, 'invalid_connection')
    const { accountId, adminDb, user } = await requireOpenWASessionAdmin()
    const body: unknown = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return deny('Invalid review request', 400, 'invalid_request')
    }
    const b = body as Record<string, unknown>
    const finding = b.finding
    const note = typeof b.note === 'string' ? b.note.trim() : ''
    if (b.action !== 'acknowledge_no_resend' || typeof b.message_id !== 'string' ||
        !UUID.test(b.message_id) || !['seen_on_whatsapp','not_seen_on_whatsapp','still_uncertain'].includes(String(finding)) ||
        note.length < 12 || note.length > 500 || b.confirm_no_resend !== true) {
      return deny('Review finding, note (12–500 chars), and no-resend confirmation required',
        400, 'review_attestation_required')
    }

    const { data, error } = await adminDb.rpc('acknowledge_openwa_ambiguous_outbound', {
      p_account_id: accountId,
      p_connection_id: connectionId,
      p_message_id: b.message_id,
      p_actor: user.id,
      p_finding: finding as ReviewFinding,
      p_review_note: note,
      p_confirm_no_resend: true,
    })
    if (error) return deny('Review could not be recorded', 502, 'review_unavailable')
    const outcome = data as { updated?: boolean; reason?: string } | null
    if (!outcome?.updated) {
      const code = ['connection_scope_mismatch','stop_required','not_eligible','already_reviewed','invalid_request']
        .includes(outcome?.reason ?? '') ? outcome!.reason! : 'review_not_allowed'
      return deny('Review not applied. Refresh the connection, keep sending stopped, and verify the message',
        409, code)
    }
    const refreshed = await adminDb.rpc('get_openwa_outbound_review_queue', {
      p_account_id: accountId, p_connection_id: connectionId,
    })
    if (refreshed.error || !refreshed.data) {
      return NextResponse.json({ updated: true, message_still_uncertain: true },
        { headers: noStore })
    }
    return NextResponse.json({
      ...refreshed.data, updated: true, message_still_uncertain: true, no_resend: true,
    }, { headers: noStore })
  } catch {
    return deny('Session-admin access required', 403, 'unauthorized')
  }
}
