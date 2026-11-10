import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveOpenWAClient } from '@/lib/whatsapp/transport/openwa/credentials'
import { authorizeConversationOpenWASendConnection } from '@/lib/whatsapp/transport/openwa/conversation-connections'
import { WhatsAppTransportError } from '@/lib/whatsapp/transport/types'
import { isOpenWAOneToOneChatId } from '@/lib/whatsapp/transport/openwa/recipient'

/** Explicitly viewing an Inbox thread acknowledges WhatsApp-side read state.
 * Uses the most recent signed, validated inbound 1:1 chat identity, scoped
 * to the authenticated user's conversation/account and its actual connection.
 * Never coerce a LID to a phone JID or let the browser select a session. */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const body = await request.json().catch(() => null) as { conversation_id?: unknown; connection_id?: unknown } | null
    const conversationId = typeof body?.conversation_id === 'string' ? body.conversation_id : ''
    if (!/^[0-9a-f-]{36}$/i.test(conversationId)) {
      return NextResponse.json({ error: 'Valid conversation_id required', code: 'invalid_conversation_id' }, { status: 400 })
    }

    const { data: conversation, error: conversationError } = await supabase
      .from('conversations').select('id').eq('id', conversationId)
      .eq('account_id', accountId).maybeSingle()
    if (conversationError || !conversation) {
      return NextResponse.json({ error: 'Conversation not found', code: 'conversation_not_found' }, { status: 404 })
    }

    const requestedConnectionId = body?.connection_id
    const db = supabaseAdmin()
    if (requestedConnectionId !== undefined && requestedConnectionId !== null) {
      if (typeof requestedConnectionId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedConnectionId)) {
        return NextResponse.json({ error: 'Invalid OpenWA connection', code: 'invalid_connection_id' }, { status: 400 })
      }
      try {
        await authorizeConversationOpenWASendConnection(db, accountId, conversationId, requestedConnectionId)
      } catch (error) {
        const code = error instanceof WhatsAppTransportError ? error.code : 'connection_restricted'
        return NextResponse.json({ error: 'OpenWA connection is not available for this conversation', code }, { status: 409 })
      }
    }

    let inboundQuery = supabase
      .from('messages').select('connection_id, provider_chat_id')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .eq('provider', 'openwa')
      .not('provider_chat_id', 'is', null)
    if (typeof requestedConnectionId === 'string') {
      inboundQuery = inboundQuery.eq('connection_id', requestedConnectionId)
    }
    const { data: inbound, error: inboundError } = await inboundQuery
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (inboundError) throw inboundError
    // Meta or legacy OpenWA chat without verified native identity:
    // never invent a destination or mark an unrelated chat read.
    if (!inbound?.connection_id || !isOpenWAOneToOneChatId(inbound.provider_chat_id)) {
      return NextResponse.json({ ok: true, providerMarked: false })
    }

    const { data: connection, error: connectionError } = await db.from('whatsapp_connections')
      .select('session_id, status').eq('id', inbound.connection_id)
      .eq('account_id', accountId).eq('provider', 'openwa').is('archived_at', null).maybeSingle()
    if (connectionError || !connection?.session_id || !['connected', 'ready'].includes(connection.status)) {
      return NextResponse.json({ error: 'OpenWA connection unavailable' }, { status: 409 })
    }

    const { client } = await resolveOpenWAClient(db, accountId, inbound.connection_id)
    await client.markChatRead(connection.session_id, inbound.provider_chat_id)
    return NextResponse.json({ ok: true, providerMarked: true })
  } catch (error) {
    // Do not return credentials, upstream response bodies or token material.
    console.warn('[openwa-read] failed to acknowledge chat', {
      kind: error instanceof Error ? error.name : 'unknown',
    })
    return toErrorResponse(error)
  }
}
