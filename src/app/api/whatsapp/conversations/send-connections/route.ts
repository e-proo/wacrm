import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { listConversationOpenWASendConnections } from '@/lib/whatsapp/transport/openwa/conversation-connections'

const noStore = { 'Cache-Control': 'no-store, private, max-age=0' }

/** Agent-visible read-only connection choices. Never expose OpenWA API keys,
 * session IDs or cross-account connections. The server checks identity again
 * on every actual send, not just here. */
export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('agent')
    const conversationId = new URL(request.url).searchParams.get('conversation_id') ?? ''
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) {
      return NextResponse.json({ error: 'Valid conversation_id is required' }, { status: 400, headers: noStore })
    }
    const options = await listConversationOpenWASendConnections(supabaseAdmin(), accountId, conversationId)
    return NextResponse.json(options, { headers: noStore })
  } catch (error) {
    return toErrorResponse(error)
  }
}
