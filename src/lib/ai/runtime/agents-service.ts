// Server-only by convention — see repositories.ts for the
// rationale on avoiding the `server-only` package.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccountId, AiAgent, AiAgentRevision, Uuid } from './multi-agent-types'

// ============================================================
// Agent publishing — the ONLY path that flips
// `ai_agents.published_revision_id`.
//
// Contract (Phase 1):
//   • Inputs: agentId, accountId, revisionId, actorUserId.
//   • Pre-flight: the revision belongs to the agent, belongs to
//     the account, has status='draft', and the agent itself is in
//     a state that allows publishing (active/paused/draft).
//   • Action inside a single transaction:
//       1. Mark the previously-published revision (if any) as
//          'superseded'.
//       2. Mark the target revision as 'published' + stamp
//          `published_at` / `published_by`.
//       3. Update `ai_agents.published_revision_id` and bump its
//          `version`.
//   • Post-conditions:
//       - Exactly one revision per agent has status='published'.
//       - The agent's status stays unchanged (publish ≠ activate).
//       - All writes share an `account_id` scope for RLS.
//
// No tool grants are validated here — that's a Phase 3 concern
// (registry + grants + policy intersection).
// ============================================================

export class PublishError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'PublishError'
    this.code = code
    this.status = status
  }
}

export interface PublishAgentRevisionInput {
  accountId: AccountId
  agentId: Uuid
  revisionId: Uuid
  actorUserId: Uuid | null
}

export async function publishAgentRevision(
  db: SupabaseClient,
  input: PublishAgentRevisionInput,
): Promise<AiAgent> {
  const { accountId, agentId, revisionId, actorUserId } = input

  // 1) Load the agent + revision in a single round-trip with the
  //    account scope applied at both levels so cross-account
  //    lookups return null rather than leaking existence.
  const { data: agent, error: agentErr } = await db
    .from('ai_agents')
    .select(
      'id, account_id, status, published_revision_id, version',
    )
    .eq('account_id', accountId)
    .eq('id', agentId)
    .maybeSingle()
  if (agentErr) throw agentErr
  if (!agent) {
    throw new PublishError('AGENT_NOT_FOUND', 'Agent not found.', 404)
  }
  const agentRow = agent as Pick<
    AiAgent,
    'id' | 'accountId' | 'status' | 'publishedRevisionId' | 'version'
  > & {
    id: string
    account_id: string
    status: string
    published_revision_id: string | null
    version: number
  }
  if (agentRow.status === 'archived') {
    throw new PublishError(
      'AGENT_ARCHIVED',
      'Cannot publish a revision of an archived agent.',
      409,
    )
  }

  const { data: revision, error: revErr } = await db
    .from('ai_agent_revisions')
    .select(
      'id, account_id, agent_id, revision_number, status, provider_connection_id',
    )
    .eq('account_id', accountId)
    .eq('agent_id', agentId)
    .eq('id', revisionId)
    .maybeSingle()
  if (revErr) throw revErr
  if (!revision) {
    throw new PublishError(
      'REVISION_NOT_FOUND',
      'Revision not found in this account.',
      404,
    )
  }
  if ((revision as { status: string }).status !== 'draft') {
    throw new PublishError(
      'REVISION_NOT_DRAFT',
      `Revision is in state '${(revision as { status: string }).status}', not draft.`,
      409,
    )
  }

  // 2) Confirm the provider connection is active (otherwise we
  //    publish a revision that can never run).
  const { data: connection, error: connErr } = await db
    .from('ai_provider_connections')
    .select('id, status')
    .eq('account_id', accountId)
    .eq('id', (revision as { provider_connection_id: string }).provider_connection_id)
    .maybeSingle()
  if (connErr) throw connErr
  if (!connection) {
    throw new PublishError(
      'CONNECTION_NOT_FOUND',
      'Provider connection not found in this account.',
      409,
    )
  }
  const connectionStatus = (connection as { status: string }).status
  if (connectionStatus !== 'active' && connectionStatus !== 'verified') {
    throw new PublishError(
      'CONNECTION_NOT_ACTIVE',
      'Provider connection must be active before publishing a revision.',
      409,
    )
  }

  // 3) The atomic swap. The migration uses REST-style clients
  //    (no direct transaction handle), so we emulate a transaction
  //    by sequencing three dependent UPDATEs whose WHERE clauses
  //    include the previous state. If a competing publish wins,
  //    any of them affects 0 rows and we surface a conflict.
  //
  //    3a) Supersede the previous published revision (if any).
  const previousId = agentRow.published_revision_id
  if (previousId && previousId !== revisionId) {
    const { error: supErr } = await db
      .from('ai_agent_revisions')
      .update({ status: 'superseded' })
      .eq('account_id', accountId)
      .eq('agent_id', agentId)
      .eq('id', previousId)
      .eq('status', 'published')
    if (supErr) throw supErr
  }

  //    3b) Publish the target revision.
  const { data: published, error: pubErr } = await db
    .from('ai_agent_revisions')
    .update({
      status: 'published',
      published_at: new Date().toISOString(),
      published_by: actorUserId,
    })
    .eq('account_id', accountId)
    .eq('agent_id', agentId)
    .eq('id', revisionId)
    .eq('status', 'draft')
    .select(
      'id, account_id, agent_id, revision_number, status, provider_connection_id, model, system_prompt, response_style, language_policy, temperature, max_output_tokens, max_tool_rounds, max_ai_replies_per_conversation, handoff_human_member_id, settings, created_at, published_at, published_by, rejection_reason',
    )
    .maybeSingle()
  if (pubErr) throw pubErr
  if (!published) {
    // Lost a race or the revision flipped state mid-flight.
    throw new PublishError(
      'PUBLISH_CONFLICT',
      'Another publish happened concurrently. Reload and retry.',
      409,
    )
  }

  //    3c) Swap the agent pointer + bump version.
  const { data: swapped, error: swapErr } = await db
    .from('ai_agents')
    .update({
      published_revision_id: revisionId,
      // Publishing implies the agent has at least one published
      // revision, so move it out of 'draft' (an admin may still
      // leave it paused).
      status: agentRow.status === 'draft' ? 'active' : agentRow.status,
      version: agentRow.version + 1,
    })
    .eq('account_id', accountId)
    .eq('id', agentId)
    .eq('version', agentRow.version)
    .select(
      'id, account_id, system_key, slug, name, description, purpose, status, published_revision_id, version, created_at, updated_at',
    )
    .maybeSingle()
  if (swapErr) throw swapErr
  if (!swapped) {
    throw new PublishError(
      'AGENT_VERSION_CONFLICT',
      'Agent was modified concurrently. Reload and retry.',
      409,
    )
  }
  return swapped as unknown as AiAgent
}

export class PauseError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'PauseError'
    this.code = code
    this.status = status
  }
}

export async function pauseAgent(
  db: SupabaseClient,
  input: { accountId: AccountId; agentId: Uuid; actorUserId: Uuid | null },
): Promise<AiAgent> {
  return mutateAgentStatus(db, input, 'paused')
}

export async function resumeAgent(
  db: SupabaseClient,
  input: { accountId: AccountId; agentId: Uuid; actorUserId: Uuid | null },
): Promise<AiAgent> {
  return mutateAgentStatus(db, input, 'active')
}

export async function archiveAgent(
  db: SupabaseClient,
  input: { accountId: AccountId; agentId: Uuid; actorUserId: Uuid | null },
): Promise<AiAgent> {
  return mutateAgentStatus(db, input, 'archived')
}

async function mutateAgentStatus(
  db: SupabaseClient,
  input: { accountId: AccountId; agentId: Uuid; actorUserId: Uuid | null },
  next: AiAgent['status'],
): Promise<AiAgent> {
  const { accountId, agentId, actorUserId } = input
  const { data: agent, error: agentErr } = await db
    .from('ai_agents')
    .select('id, account_id, status, version')
    .eq('account_id', accountId)
    .eq('id', agentId)
    .maybeSingle()
  if (agentErr) throw agentErr
  if (!agent) {
    throw new PauseError('AGENT_NOT_FOUND', 'Agent not found.', 404)
  }
  const row = agent as { status: string; version: number }
  if (row.status === 'archived' && next !== 'archived') {
    throw new PauseError(
      'AGENT_ARCHIVED',
      'Cannot transition an archived agent.',
      409,
    )
  }
  if (!agentRowHasPublishedRevision(db, accountId, agentId) && next === 'active') {
    throw new PauseError(
      'AGENT_NOT_PUBLISHED',
      'Cannot activate an agent with no published revision.',
      409,
    )
  }
  const { data: updated, error: updErr } = await db
    .from('ai_agents')
    .update({
      status: next,
      version: row.version + 1,
      updated_by: actorUserId,
    })
    .eq('account_id', accountId)
    .eq('id', agentId)
    .eq('version', row.version)
    .select(
      'id, account_id, system_key, slug, name, description, purpose, status, published_revision_id, version, created_at, updated_at',
    )
    .maybeSingle()
  if (updErr) throw updErr
  if (!updated) {
    throw new PauseError(
      'VERSION_CONFLICT',
      'Agent was modified concurrently. Reload and retry.',
      409,
    )
  }
  return updated as unknown as AiAgent
}

async function agentRowHasPublishedRevision(
  db: SupabaseClient,
  accountId: AccountId,
  agentId: Uuid,
): Promise<boolean> {
  const { data, error } = await db
    .from('ai_agent_revisions')
    .select('id', { head: true, count: 'exact' })
    .eq('account_id', accountId)
    .eq('agent_id', agentId)
    .eq('status', 'published')
    .limit(1)
  if (error) throw error
  return (data as unknown as { length?: number }) != null
    && ((data as unknown as { length: number }).length ?? 0) > 0
}
