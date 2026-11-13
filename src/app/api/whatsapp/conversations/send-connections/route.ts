import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { canEditSettings } from '@/lib/auth/roles'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'
import { refreshOpenWAConnectionStatus } from '@/lib/whatsapp/transport/openwa/session-lifecycle'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { listConversationOpenWASendConnections } from '@/lib/whatsapp/transport/openwa/conversation-connections'

const noStore = { 'Cache-Control': 'no-store, private, max-age=0' }

/** Agent-visible read-only connection choices. Never expose OpenWA API keys,
 * session IDs or cross-account connections. The server checks identity again
 * on every actual send, not just here. */
export async function GET(request: Request) {
  try {
    const { accountId, role } = await requireRole('agent')
    const conversationId = new URL(request.url).searchParams.get('conversation_id') ?? ''
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) {
      return NextResponse.json({ error: 'Valid conversation_id is required' }, { status: 400, headers: noStore })
    }
    const options = await listConversationOpenWASendConnections(supabaseAdmin(), accountId, conversationId)
    return NextResponse.json({ ...options, can_refresh: canEditSettings(role) }, { headers: noStore })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/** Explicit, admin-only read/refresh of ONE verified same-phone OpenWA session.
 * No provider auto-switch, QR, session creation or outbound send. */
export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('admin')
    const body = await request.json().catch(() => null) as { conversation_id?: unknown; connection_id?: unknown } | null
    const isUuid = (value: unknown): value is string =>
      typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    if (!isUuid(body?.conversation_id) || !isUuid(body?.connection_id)) {
      return NextResponse.json({ code: 'invalid_request', error: 'Valid conversation and connection IDs are required' }, { status: 400, headers: noStore })
    }
    const db = supabaseAdmin()
    const available = await listConversationOpenWASendConnections(db, accountId, body.conversation_id)
    const allowed = [...available.options, ...available.unavailable_options]
      .some((option) => option.id === body.connection_id)
    if (!available.current_connection_id || !allowed) {
      return NextResponse.json({
        code: 'connection_restricted', error: 'This OpenWA session is not verified for the conversation and account',
      }, { status: 409, headers: noStore })
    }
    const result = await refreshOpenWAConnectionStatus(db, accountId, body.connection_id)
    // Deliberate separate step: the operator must select a ready sender manually.
    return NextResponse.json({ status: result.status }, { headers: noStore })
  } catch (error) {
    if (error instanceof WhatsAppTransportError) {
      return NextResponse.json({
        code: error.code, error: error.message,
      }, { status: error.code === 'connection_restricted' ? 409
        : error.code === 'invalid_request' ? 400 : 502, headers: noStore })
    }
    return toErrorResponse(error)
  }
}
