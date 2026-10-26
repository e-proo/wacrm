import type { SupabaseClient } from '@supabase/supabase-js'

export type ConversationInboundProvider = 'meta_cloud' | 'openwa' | null

export function assertMetaOutboundProviderBoundary(
  provider: ConversationInboundProvider,
): void {
  if (provider === 'openwa') {
    throw new Error('unsupported_capability: OpenWA outbound is not enabled before OW-7')
  }
}

/**
 * OW-6 safety boundary.
 *
 * The shared inbound pipeline is allowed to run business fan-out for OpenWA,
 * but until OW-7 no code path may answer an OpenWA conversation through the
 * legacy Meta transport. Resolve the most recent customer message inside the
 * account-scoped conversation and fail closed when it came from OpenWA.
 */
export async function assertConversationAllowsMetaOutbound(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<void> {
  const { data: conversation, error: conversationError } = await db
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (conversationError || !conversation) {
    throw new Error('invalid_request: conversation not found for this account')
  }

  const { data: inbound, error: inboundError } = await db
    .from('messages')
    .select('provider')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (inboundError) {
    throw new Error('retryable_provider_failure: could not resolve conversation provider')
  }

  const provider = (inbound?.provider ?? null) as ConversationInboundProvider
  assertMetaOutboundProviderBoundary(provider)
}
