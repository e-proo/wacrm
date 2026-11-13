import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveWhatsAppTransport } from '@/lib/whatsapp/transport/router'
import type { WhatsAppProvider } from '@/lib/whatsapp/transport/types'

export interface FrozenAgentTaskTransport {
  accountId: string
  connectionId: string
  provider: WhatsAppProvider
}

type ConnectionLookup = (
  db: SupabaseClient,
  accountId: string,
  connectionId: string,
) => Promise<{ connectionId: string; provider: WhatsAppProvider }>

const resolveBoundConnection: ConnectionLookup = async (db, accountId, connectionId) => {
  const resolved = await resolveWhatsAppTransport(db, accountId, connectionId)
  return { connectionId: resolved.connectionId, provider: resolved.transport.provider }
}

/**
 * Runs before claim_bound_agent_task_outbound_message acquires transport ownership.
 * Resolves the real provider adapter/credentials but NEVER calls send().
 * Any unavailable, wrong-tenant, missing-credential or changed session fails
 * closed without pretending that WhatsApp accepted a message.
 */
export async function preflightAgentTaskConnection(
  db: SupabaseClient,
  binding: FrozenAgentTaskTransport,
  lookup: ConnectionLookup = resolveBoundConnection,
): Promise<boolean> {
  if (!binding.accountId || !binding.connectionId || !binding.provider) return false
  try {
    const selected = await lookup(db, binding.accountId, binding.connectionId)
    return (
      selected.connectionId === binding.connectionId &&
      selected.provider === binding.provider
    )
  } catch {
    return false
  }
}
