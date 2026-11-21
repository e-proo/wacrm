import { NextResponse } from 'next/server'
import { requireOpenWASessionAdmin } from '@/lib/whatsapp/transport/openwa/session-auth'
import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'
import { enrollVerifiedInboxChannel } from '@/lib/inbox/verified-channel-enrollment'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'

const headers = { 'Cache-Control': 'no-store, private, max-age=0' }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Explicit admin-only TEST shadow operation. No session start/send/activation.
export async function POST(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    const { accountId, user, adminDb } = await requireOpenWASessionAdmin()
    if (!isOpenWATestProject() || process.env.WACRM_INBOX_SHADOW_ENROLLMENT !== 'true') {
      return NextResponse.json({ error: 'Inbox shadow enrollment is disabled' }, { status: 403, headers })
    }
    const { connectionId } = await context.params
    if (!uuid.test(connectionId)) return NextResponse.json({ error: 'Invalid connection' }, { status: 400, headers })
    const body: unknown = await request.json().catch(() => null)
    if (typeof body !== 'object' || !body || Array.isArray(body)
      || Object.keys(body).some(key => key !== 'makePrimary')
      || ('makePrimary' in body && typeof body.makePrimary !== 'boolean')) {
      return NextResponse.json({ error: 'Invalid enrollment request' }, { status: 400, headers })
    }
    const result = await enrollVerifiedInboxChannel(adminDb, { accountId, actorId: user.id, connectionId, makePrimary: 'makePrimary' in body && body.makePrimary === true })
    return NextResponse.json(result, { headers })
  } catch (error) {
    const status = error instanceof WhatsAppTransportError && error.code === 'authentication_or_configuration' ? 403 : 409
    return NextResponse.json({ error: 'Verified enrollment could not be completed' }, { status, headers })
  }
}
