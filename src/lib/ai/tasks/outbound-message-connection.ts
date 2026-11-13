import type { SupabaseClient } from '@supabase/supabase-js'
import type { WhatsAppProvider } from '@/lib/whatsapp/transport/types'

export interface TaskMessageConnection {
  connectionId: string
  provider: WhatsAppProvider
}

export class TaskMessageConnectionError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'TaskMessageConnectionError'
  }
}

/** Mirrors the authoritative bound-reservation RPC selection rule.
 * No inferred Meta fallback, no archived or cross-tenant session and no
 * client-provided provider. The SQL reservation rechecks all of this.
 */
export async function resolveTaskMessageConnection(
  db: SupabaseClient,
  input: {
    accountId: string
    conversationId: string
    targetPolicy: Readonly<Record<string, unknown>>
  },
): Promise<TaskMessageConnection> {
  let connectionId: string | null = null
  if (Object.prototype.hasOwnProperty.call(input.targetPolicy, 'whatsappConnectionId')) {
    const selected = input.targetPolicy.whatsappConnectionId
    if (typeof selected !== 'string' || !/^[0-9a-f-]{36}$/i.test(selected)) {
      throw new TaskMessageConnectionError('connection_selection_invalid')
    }
    connectionId = selected
  } else {
    const { data, error } = await db.from('messages')
      .select('connection_id')
      .eq('conversation_id', input.conversationId)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1).maybeSingle()
    if (error) throw error
    connectionId = data?.connection_id ?? null
  }
  if (!connectionId) throw new TaskMessageConnectionError('connection_selection_required')
  const { data, error } = await db.from('whatsapp_connections')
    .select('id,provider,status,archived_at,session_id')
    .eq('account_id', input.accountId)
    .eq('id', connectionId).maybeSingle()
  if (error) throw error
  if (!data) throw new TaskMessageConnectionError('connection_not_found')
  if (data.archived_at) throw new TaskMessageConnectionError('connection_archived')
  if (data.provider === 'meta_cloud' && data.status === 'connected') {
    return { connectionId: data.id, provider: 'meta_cloud' }
  }
  if (data.provider === 'openwa' &&
      (data.status === 'ready' || data.status === 'connected') &&
      data.session_id) {
    return { connectionId: data.id, provider: 'openwa' }
  }
  throw new TaskMessageConnectionError('connection_not_ready')
}
