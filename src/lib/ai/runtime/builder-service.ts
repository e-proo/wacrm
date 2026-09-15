import type { SupabaseClient } from '@supabase/supabase-js'
import { getRegisteredTool } from './tool-registry'
import { analyzeRouteConflicts } from './route-conflicts'

export interface PublishCheck {
  path: string
  code: string
  message: string
  severity: 'error' | 'warning'
}

export interface PublishValidationResult {
  ok: boolean
  checks: PublishCheck[]
}

/** Deterministic, side-effect-free publish checklist for the builder. */
export async function validateAgentRevisionForPublish(
  db: SupabaseClient,
  input: { accountId: string; agentId: string; revisionId: string },
): Promise<PublishValidationResult> {
  const checks: PublishCheck[] = []
  const { accountId, agentId, revisionId } = input
  const [agentRes, revisionRes, connectionsRes, grantsRes, routesRes, identitiesRes, budgetsRes] =
    await Promise.all([
      db.from('ai_agents').select('id, status, published_revision_id').eq('account_id', accountId).eq('id', agentId).maybeSingle(),
      db.from('ai_agent_revisions').select('id, agent_id, status, provider_connection_id, model, max_tool_rounds').eq('account_id', accountId).eq('id', revisionId).maybeSingle(),
      db.from('ai_provider_connections').select('id, status').eq('account_id', accountId),
      db.from('ai_agent_tool_grants').select('tool_key, tool_version, permission').eq('account_id', accountId).eq('agent_revision_id', revisionId),
      db.from('ai_agent_routes').select('id, account_id, agent_id, name, channel, route_kind, priority, is_active, conditions, stop_processing, created_at, updated_at').eq('account_id', accountId),
      db.from('trusted_admin_identities').select('id', { head: true, count: 'exact' }).eq('account_id', accountId).eq('status', 'active').limit(1),
      db.from('ai_agent_budget_policies').select('id').eq('account_id', accountId).eq('is_active', true),
    ])
  if (agentRes.error) throw agentRes.error
  if (revisionRes.error) throw revisionRes.error
  if (connectionsRes.error) throw connectionsRes.error
  if (grantsRes.error) throw grantsRes.error
  if (routesRes.error) throw routesRes.error
  if (identitiesRes.error) throw identitiesRes.error
  if (budgetsRes.error) throw budgetsRes.error

  const agent = agentRes.data as { status: string } | null
  const revision = revisionRes.data as { status: string; provider_connection_id: string | null; model: string; max_tool_rounds: number } | null
  const selectedConnection = revision?.provider_connection_id
    ? (connectionsRes.data ?? []).find((row) => row.id === revision.provider_connection_id)
    : null
  if (!agent) checks.push({ path: 'agentId', code: 'AGENT_NOT_FOUND', message: 'Agent not found in this account.', severity: 'error' })
  if (!revision) checks.push({ path: 'revisionId', code: 'REVISION_NOT_FOUND', message: 'Revision not found in this account.', severity: 'error' })
  if (agent?.status === 'archived') checks.push({ path: 'agent.status', code: 'AGENT_ARCHIVED', message: 'Archived agents cannot be published.', severity: 'error' })
  if (revision && revision.status !== 'draft') checks.push({ path: 'revision.status', code: 'REVISION_NOT_DRAFT', message: 'Only draft revisions can be published.', severity: 'error' })
  if (revision && !revision.provider_connection_id) checks.push({ path: 'revision.provider_connection_id', code: 'PROVIDER_CONNECTION_REQUIRED', message: 'A provider connection is required.', severity: 'error' })
  if (revision?.provider_connection_id && !selectedConnection) checks.push({ path: 'revision.provider_connection_id', code: 'CONNECTION_NOT_FOUND', message: 'The selected provider connection no longer exists in this account.', severity: 'error' })
  if (selectedConnection && !['active', 'verified'].includes(selectedConnection.status)) checks.push({ path: 'revision.provider_connection_id', code: 'CONNECTION_NOT_ACTIVE', message: 'The selected provider connection is not active.', severity: 'error' })
  if (revision && !revision.model.trim()) checks.push({ path: 'revision.model', code: 'MODEL_REQUIRED', message: 'A model is required.', severity: 'error' })
  if (revision && revision.max_tool_rounds > 0 && (grantsRes.data ?? []).length === 0) checks.push({ path: 'tools', code: 'TOOLS_REQUIRED', message: 'Tool rounds are enabled but no tool grants exist.', severity: 'error' })
  if (revision && revision.max_tool_rounds < 0) checks.push({ path: 'revision.max_tool_rounds', code: 'INVALID_TOOL_ROUNDS', message: 'Tool rounds cannot be negative.', severity: 'error' })

  for (const grant of grantsRes.data ?? []) {
    const row = grant as { tool_key: string; tool_version: number; permission: string }
    const tool = getRegisteredTool(row.tool_key)
    if (!tool) checks.push({ path: `grants.${row.tool_key}`, code: 'UNKNOWN_TOOL', message: `Tool ${row.tool_key} is not registered.`, severity: 'error' })
    else if (tool.version !== row.tool_version) checks.push({ path: `grants.${row.tool_key}`, code: 'STALE_TOOL_VERSION', message: `Tool ${row.tool_key} requires version ${tool.version}.`, severity: 'error' })
    else if (!tool.grantPermissions.includes(row.permission as never)) checks.push({ path: `grants.${row.tool_key}`, code: 'PERMISSION_NOT_ALLOWED', message: `Permission ${row.permission} is not allowed for ${row.tool_key}.`, severity: 'error' })
  }

  const conflicts = analyzeRouteConflicts({
    routes: (routesRes.data ?? []) as never,
    agents: agent ? [{ id: agentId, status: agent.status as never, purpose: 'custom' as never }] : [],
    hasActiveTrustedIdentity: (identitiesRes.count ?? 0) > 0,
  })
  for (const conflict of conflicts) {
    checks.push({ path: 'routes', code: conflict.code, message: conflict.message, severity: conflict.severity === 'blocker' ? 'error' : 'warning' })
  }
  if ((budgetsRes.data ?? []).length === 0) checks.push({ path: 'budget', code: 'NO_BUDGET_POLICY', message: 'No active budget policy is configured; account defaults apply.', severity: 'warning' })
  return { ok: !checks.some((check) => check.severity === 'error'), checks }
}

export function validateTestCaseShape(input: unknown): PublishCheck[] {
  const checks: PublishCheck[] = []
  if (!input || typeof input !== 'object') return [{ path: 'testCase', code: 'INVALID_TEST_CASE', message: 'Test case must be an object.', severity: 'error' }]
  const value = input as { name?: unknown; input_messages?: unknown; assertions?: unknown }
  if (typeof value.name !== 'string' || !value.name.trim()) checks.push({ path: 'name', code: 'NAME_REQUIRED', message: 'Test case name is required.', severity: 'error' })
  if (!Array.isArray(value.input_messages) || value.input_messages.length === 0 || value.input_messages.length > 3) checks.push({ path: 'input_messages', code: 'INVALID_MESSAGES', message: 'Use one to three input messages.', severity: 'error' })
  if (!value.assertions || typeof value.assertions !== 'object') checks.push({ path: 'assertions', code: 'ASSERTIONS_REQUIRED', message: 'Assertions are required.', severity: 'error' })
  return checks
}
