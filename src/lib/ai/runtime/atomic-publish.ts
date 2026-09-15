import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiAgent } from './multi-agent-types'
import { PublishError } from './agents-service'

/**
 * Atomic publish entry point backed by migration 065's PL/pgSQL function.
 * Pre-flight validation remains in the API/builder; the database transaction
 * owns the actual supersede/publish/pointer swap.
 */
export async function publishAgentRevisionAtomic(
  db: SupabaseClient,
  input: {
    accountId: string
    agentId: string
    revisionId: string
    actorUserId: string | null
  },
): Promise<AiAgent> {
  const { data: agent, error: readError } = await db
    .from('ai_agents')
    .select('version')
    .eq('account_id', input.accountId)
    .eq('id', input.agentId)
    .maybeSingle()
  if (readError) throw readError
  if (!agent) throw new PublishError('AGENT_NOT_FOUND', 'Agent not found.', 404)

  const { data, error } = await db.rpc('publish_ai_agent_revision_atomic', {
    p_account_id: input.accountId,
    p_agent_id: input.agentId,
    p_revision_id: input.revisionId,
    p_expected_agent_version: (agent as { version: number }).version,
    p_actor_user_id: input.actorUserId,
  })
  if (error) {
    const message = (error as { message?: string }).message ?? 'Publish failed.'
    const known = [
      'AGENT_NOT_FOUND',
      'AGENT_VERSION_CONFLICT',
      'REVISION_NOT_FOUND',
      'REVISION_NOT_DRAFT',
      'AGENT_ARCHIVED',
      'CONNECTION_NOT_FOUND',
      'CONNECTION_NOT_ACTIVE',
      'PUBLISH_CONFLICT',
    ].find((code) => message.includes(code))
    throw new PublishError(known ?? 'PUBLISH_FAILED', message, known?.includes('NOT_FOUND') ? 404 : 409)
  }
  if (!data) throw new PublishError('PUBLISH_FAILED', 'Atomic publish returned no agent.', 500)
  return data as unknown as AiAgent
}
