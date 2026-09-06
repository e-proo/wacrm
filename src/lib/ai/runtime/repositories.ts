// Server-only by convention (see comments). We intentionally do
// NOT use the `server-only` package — the rest of this codebase
// relies on Next.js build boundaries + import-path comments to
// enforce it, so a bare `import 'server-only'` would break the
// webhook test suite which imports the route from a non-server
// vitest environment.
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '../admin-client'
import type {
  AccountId,
  AiAgent,
  AiAgentRevision,
  AiAgentRoute,
  ConversationAiState,
  RoutingSnapshot,
  RouteConditions,
  TrustedAdminIdentity,
  Uuid,
} from './multi-agent-types'

// ============================================================
// Account-scoped reads for the router and admin UI.
//
// Every helper here is server-only (the `'server-only'` import at
// the top throws at build time if it leaks into a client bundle).
// All callers pass an explicit Supabase client — most production
// callers pass the admin/service-role client because reads cross
// the webhook's no-auth boundary; the dashboard callers pass the
// RLS-scoped SSR client so policy is honored at the DB layer.
//
// Read shapes are DTOs (no `version`/audit noise) so the router
// can stay a pure function. Mutations are NOT here — they live in
// services (publish, revoke, route authoring) so audit + business
// rules stay in one place.
// ============================================================

type Db = SupabaseClient

export interface LoadSnapshotOptions {
  /** When true, only ACTIVE admin identities are loaded (the only
   *  kind the router honors). Set false for admin UIs that need
   *  pending / revoked rows. */
  activeAdminOnly?: boolean
}

/**
 * One round-trip per concern. Returns `null` for missing tables
 * so a deploy without migration 045/046 applied degrades cleanly
 * (router → skip → legacy path wins).
 */
export async function loadRoutingSnapshot(
  db: Db,
  accountId: AccountId,
  opts: LoadSnapshotOptions = {},
): Promise<RoutingSnapshot> {
  const activeAdminOnly = opts.activeAdminOnly ?? true

  const [identitiesRes, routesRes, agentsRes] = await Promise.all([
    db
      .from('trusted_admin_identities')
      .select(
        'id, account_id, channel, normalized_address, display_name, member_id, status, verification_method, verified_at, revoked_at, allowed_capabilities, created_at',
      )
      .eq('account_id', accountId)
      .eq('channel', 'whatsapp')
      .eq('status', activeAdminOnly ? 'active' : undefined)
      .is('revoked_at', null),
    db
      .from('ai_agent_routes')
      .select(
        'id, account_id, agent_id, name, channel, route_kind, priority, is_active, conditions, stop_processing, created_at, updated_at',
      )
      .eq('account_id', accountId)
      .eq('is_active', true)
      .eq('channel', 'whatsapp'),
    db
      .from('ai_agents')
      .select(
        'id, account_id, system_key, slug, name, description, purpose, status, published_revision_id, version, created_at, updated_at, ai_agent_revisions!ai_agents_published_revision_fk(id, account_id, agent_id, revision_number, status, provider_connection_id, model, system_prompt, response_style, language_policy, temperature, max_output_tokens, max_tool_rounds, max_ai_replies_per_conversation, handoff_human_member_id, settings, created_at, published_at, published_by, rejection_reason)',
      )
      .eq('account_id', accountId)
      .in('status', ['active', 'paused']),
  ])

  if (identitiesRes.error) throw identitiesRes.error
  if (routesRes.error) throw routesRes.error
  if (agentsRes.error) throw agentsRes.error

  return {
    trustedIdentities: (identitiesRes.data ?? []).map(mapIdentity),
    routes: (routesRes.data ?? []).map(mapRoute),
    agents: (agentsRes.data ?? []).map(mapAgentWithRevision),
  }
}

export async function loadConversationAiState(
  db: Db,
  conversationId: Uuid,
): Promise<ConversationAiState | null> {
  const { data, error } = await db
    .from('conversation_ai_state')
    .select(
      'conversation_id, account_id, assigned_ai_agent_id, mode, pause_until, reason, version, updated_at',
    )
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) throw error
  return data ? mapAiState(data) : null
}

export async function loadAgent(
  db: Db,
  accountId: AccountId,
  agentId: Uuid,
): Promise<AiAgent | null> {
  const { data, error } = await db
    .from('ai_agents')
    .select(
      'id, account_id, system_key, slug, name, description, purpose, status, published_revision_id, version, created_at, updated_at',
    )
    .eq('account_id', accountId)
    .eq('id', agentId)
    .maybeSingle()
  if (error) throw error
  return data ? (data as unknown as AiAgent) : null
}

export async function loadAgentRevision(
  db: Db,
  accountId: AccountId,
  revisionId: Uuid,
): Promise<AiAgentRevision | null> {
  const { data, error } = await db
    .from('ai_agent_revisions')
    .select(
      'id, account_id, agent_id, revision_number, status, provider_connection_id, model, system_prompt, response_style, language_policy, temperature, max_output_tokens, max_tool_rounds, max_ai_replies_per_conversation, handoff_human_member_id, settings, created_at, published_at, published_by, rejection_reason',
    )
    .eq('account_id', accountId)
    .eq('id', revisionId)
    .maybeSingle()
  if (error) throw error
  return data ? (data as unknown as AiAgentRevision) : null
}

export async function loadRevisionGrants(
  db: Db,
  accountId: AccountId,
  revisionId: Uuid,
): Promise<
  Array<{
    toolKey: string
    toolVersion: number
    permission: 'read' | 'propose' | 'execute'
    constraints: Record<string, unknown>
  }>
> {
  const { data, error } = await db
    .from('ai_agent_tool_grants')
    .select('tool_key, tool_version, permission, constraints')
    .eq('account_id', accountId)
    .eq('agent_revision_id', revisionId)
  if (error) throw error
  return (data ?? []).map((row) => ({
    toolKey: row.tool_key as string,
    toolVersion: row.tool_version as number,
    permission: row.permission as 'read' | 'propose' | 'execute',
    constraints: (row.constraints as Record<string, unknown>) ?? {},
  }))
}

// --- convenience for the webhook (uses admin client + skips RLS) --------

export async function loadRoutingSnapshotAdmin(
  accountId: AccountId,
): Promise<RoutingSnapshot> {
  return loadRoutingSnapshot(supabaseAdmin(), accountId)
}

// --- mappers (snake_case → camelCase) ------------------------------------

interface RawIdentity {
  id: string
  account_id: string
  channel: string
  normalized_address: string
  display_name: string | null
  member_id: string | null
  status: string
  verification_method: string | null
  verified_at: string | null
  revoked_at: string | null
  allowed_capabilities: unknown
  created_at: string
}

function mapIdentity(row: RawIdentity): TrustedAdminIdentity {
  return {
    id: row.id,
    accountId: row.account_id,
    channel: row.channel as TrustedAdminIdentity['channel'],
    normalizedAddress: row.normalized_address,
    displayName: row.display_name,
    memberId: row.member_id,
    status: row.status as TrustedAdminIdentity['status'],
    verificationMethod:
      (row.verification_method as TrustedAdminIdentity['verificationMethod']) ??
      null,
    verifiedAt: row.verified_at,
    revokedAt: row.revoked_at,
    allowedCapabilities: Array.isArray(row.allowed_capabilities)
      ? (row.allowed_capabilities as string[])
      : [],
    createdAt: row.created_at,
  }
}

interface RawRoute {
  id: string
  account_id: string
  agent_id: string
  name: string
  channel: string
  route_kind: string
  priority: number
  is_active: boolean
  conditions: unknown
  stop_processing: boolean
  created_at: string
  updated_at: string
}

function mapRoute(row: RawRoute): AiAgentRoute {
  return {
    id: row.id,
    accountId: row.account_id,
    agentId: row.agent_id,
    name: row.name,
    channel: row.channel as AiAgentRoute['channel'],
    routeKind: row.route_kind as AiAgentRoute['routeKind'],
    priority: row.priority,
    isActive: row.is_active,
    conditions: (row.conditions as RouteConditions) ?? {},
    stopProcessing: row.stop_processing,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface RawAgentWithRevision {
  id: string
  account_id: string
  system_key: string | null
  slug: string
  name: string
  description: string | null
  purpose: string
  status: string
  published_revision_id: string | null
  version: number
  created_at: string
  updated_at: string
  ai_agent_revisions:
    | {
        id: string
        account_id: string
        agent_id: string
        revision_number: number
        status: string
        provider_connection_id: string
        model: string
        system_prompt: string | null
        response_style: string
        language_policy: string
        temperature: number | null
        max_output_tokens: number | null
        max_tool_rounds: number
        max_ai_replies_per_conversation: number
        handoff_human_member_id: string | null
        settings: unknown
        created_at: string
        published_at: string | null
        published_by: string | null
        rejection_reason: string | null
      }
    | null
    | Array<{
        id: string
        account_id: string
        agent_id: string
        revision_number: number
        status: string
        provider_connection_id: string
        model: string
        system_prompt: string | null
        response_style: string
        language_policy: string
        temperature: number | null
        max_output_tokens: number | null
        max_tool_rounds: number
        max_ai_replies_per_conversation: number
        handoff_human_member_id: string | null
        settings: unknown
        created_at: string
        published_at: string | null
        published_by: string | null
        rejection_reason: string | null
      }>
}

function mapAgentWithRevision(
  row: RawAgentWithRevision,
): { agent: AiAgent; revision: AiAgentRevision | null } {
  const agent: AiAgent = {
    id: row.id,
    accountId: row.account_id,
    systemKey: row.system_key as AiAgent['systemKey'],
    slug: row.slug,
    name: row.name,
    description: row.description,
    purpose: row.purpose as AiAgent['purpose'],
    status: row.status as AiAgent['status'],
    publishedRevisionId: row.published_revision_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  const rawRev = Array.isArray(row.ai_agent_revisions)
    ? row.ai_agent_revisions[0]
    : row.ai_agent_revisions
  const revision: AiAgentRevision | null = rawRev
    ? {
        id: rawRev.id,
        accountId: rawRev.account_id,
        agentId: rawRev.agent_id,
        revisionNumber: rawRev.revision_number,
        status: rawRev.status as AiAgentRevision['status'],
        providerConnectionId: rawRev.provider_connection_id,
        model: rawRev.model,
        systemPrompt: rawRev.system_prompt,
        responseStyle: rawRev.response_style as AiAgentRevision['responseStyle'],
        languagePolicy: rawRev.language_policy,
        temperature: rawRev.temperature,
        maxOutputTokens: rawRev.max_output_tokens,
        maxToolRounds: rawRev.max_tool_rounds,
        maxAiRepliesPerConversation: rawRev.max_ai_replies_per_conversation,
        handoffHumanMemberId: rawRev.handoff_human_member_id,
        settings: (rawRev.settings as Record<string, unknown>) ?? {},
        createdAt: rawRev.created_at,
        publishedAt: rawRev.published_at,
        publishedBy: rawRev.published_by,
        rejectionReason: rawRev.rejection_reason,
      }
    : null
  return { agent, revision }
}

function mapAiState(row: {
  conversation_id: string
  account_id: string
  assigned_ai_agent_id: string | null
  mode: string
  pause_until: string | null
  reason: string | null
  version: number
  updated_at: string
}): ConversationAiState {
  return {
    conversationId: row.conversation_id,
    accountId: row.account_id,
    assignedAiAgentId: row.assigned_ai_agent_id,
    mode: row.mode as ConversationAiState['mode'],
    pauseUntil: row.pause_until,
    reason: row.reason,
    version: row.version,
    updatedAt: row.updated_at,
  }
}
