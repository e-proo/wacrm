import type { SupabaseClient } from '@supabase/supabase-js'
import { getCurrentPlatformTool } from '../tools/platform/current-domain-registry'
import { analyzeRouteConflicts } from './route-conflicts'
import { planeForAgentPurpose } from './tool-grant-plane-policy'
import {
  isAgentBuilderV2Configuration,
  validateBuilderV2Configuration,
} from '../tasks/builder-v2'
import {
  loadAgentRevisionCapabilities,
  type AgentRevisionToolGrant,
} from '../tasks/capability-policy'
import { CURRENT_AGENT_TASK_PLATFORM } from '../tasks/current-platform'

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
  const [agentRes, revisionRes, connectionsRes, grantsRes, routesRes, identitiesRes, budgetsRes, revisionCapabilities] =
    await Promise.all([
      db.from('ai_agents').select('id, status, purpose, published_revision_id').eq('account_id', accountId).eq('id', agentId).maybeSingle(),
      db.from('ai_agent_revisions').select('id, agent_id, status, provider_connection_id, model, max_tool_rounds, handoff_human_member_id, operational_mode, outreach_policy').eq('account_id', accountId).eq('id', revisionId).maybeSingle(),
      db.from('ai_provider_connections').select('id, status').eq('account_id', accountId),
      db.from('ai_agent_tool_grants').select('tool_key, tool_version, permission').eq('account_id', accountId).eq('agent_revision_id', revisionId),
      db.from('ai_agent_routes').select('id, account_id, agent_id, name, channel, route_kind, priority, is_active, conditions, stop_processing, created_at, updated_at').eq('account_id', accountId),
      db.from('trusted_admin_identities').select('id', { head: true, count: 'exact' }).eq('account_id', accountId).eq('status', 'active').limit(1),
      db.from('ai_agent_budget_policies').select('id').eq('account_id', accountId).eq('is_active', true),
      loadAgentRevisionCapabilities(db, { accountId, revisionId }),
    ])
  if (agentRes.error) throw agentRes.error
  if (revisionRes.error) throw revisionRes.error
  if (connectionsRes.error) throw connectionsRes.error
  if (grantsRes.error) throw grantsRes.error
  if (routesRes.error) throw routesRes.error
  if (identitiesRes.error) throw identitiesRes.error
  if (budgetsRes.error) throw budgetsRes.error

  const agent = agentRes.data as {
    status: string
    purpose: 'customer_support' | 'admin_operations' | 'custom'
  } | null
  const revision = revisionRes.data as {
    status: string
    provider_connection_id: string | null
    model: string
    max_tool_rounds: number
    handoff_human_member_id: string | null
    operational_mode: string
    outreach_policy: Record<string, unknown> | null
  } | null
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
  if (agent?.purpose === 'admin_operations' && revision && revision.max_tool_rounds < 1) checks.push({ path: 'revision.max_tool_rounds', code: 'ADMIN_TOOL_ROUNDS_REQUIRED', message: 'Admin operations agents require at least one tool round so they can read authoritative business data.', severity: 'error' })
  if (agent?.purpose === 'customer_support' && revision && !revision.handoff_human_member_id) checks.push({ path: 'revision.handoff_human_member_id', code: 'HANDOFF_MEMBER_REQUIRED', message: 'Customer support agents require a human handoff teammate.', severity: 'error' })
  if (revision) {
    const rawPolicy = revision.outreach_policy ?? {}
    const configCandidate = {
      operationalMode: revision.operational_mode ?? 'reactive',
      bindings:
        rawPolicy &&
        typeof rawPolicy === 'object' &&
        !Array.isArray(rawPolicy)
          ? rawPolicy.bindings ?? []
          : null,
    }

    if (!isAgentBuilderV2Configuration(configCandidate)) {
      checks.push({
        path: 'revision.outreach_policy',
        code: 'INVALID_BUILDER_V2_CONFIGURATION',
        message: 'Builder V2 configuration has an invalid persisted shape.',
        severity: 'error',
      })
    } else {
      const revisionToolGrants: AgentRevisionToolGrant[] = (
        grantsRes.data ?? []
      ).map((row) => ({
        toolKey: row.tool_key as string,
        toolVersion: row.tool_version as number,
        permission: row.permission as AgentRevisionToolGrant['permission'],
      }))
      const builderValidation = validateBuilderV2Configuration({
        config: configCandidate,
        registry: CURRENT_AGENT_TASK_PLATFORM.taskTypes,
        revisionToolGrants,
      })
      for (const issue of builderValidation.issues) {
        checks.push({
          path: `revision.outreach_policy.${issue.path}`,
          code: issue.code,
          message: issue.message,
          severity: 'error',
        })
      }

      if (configCandidate.operationalMode !== 'reactive') {
        const actualCapabilities = new Set(revisionCapabilities)
        const missingCapabilities = builderValidation.capabilities.filter(
          (capability) => !actualCapabilities.has(capability),
        )
        const requiredCapabilities = new Set(builderValidation.capabilities)
        const staleCapabilities = revisionCapabilities.filter(
          (capability) => !requiredCapabilities.has(capability),
        )

        if (missingCapabilities.length > 0) {
          checks.push({
            path: 'revision.capabilities',
            code: 'AGENT_CAPABILITY_MISSING',
            message:
              'Builder V2 configuration requires missing capabilities: ' +
              missingCapabilities.join(', '),
            severity: 'error',
          })
        }
        if (staleCapabilities.length > 0) {
          checks.push({
            path: 'revision.capabilities',
            code: 'AGENT_CAPABILITY_SET_STALE',
            message:
              'Builder V2 capabilities must be resaved after task/tool changes. Stale capabilities: ' +
              staleCapabilities.join(', '),
            severity: 'error',
          })
        }
      }
    }
  }
  if (revision?.handoff_human_member_id) {
    const { data: member, error: memberError } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .eq('user_id', revision.handoff_human_member_id)
      .maybeSingle()
    if (memberError) throw memberError
    if (!member) checks.push({ path: 'revision.handoff_human_member_id', code: 'HANDOFF_MEMBER_INVALID', message: 'The configured handoff teammate is not a member of this account.', severity: 'error' })
  }

  const expectedPlane = agent ? planeForAgentPurpose(agent.purpose) : null

  for (const grant of grantsRes.data ?? []) {
    const row = grant as { tool_key: string; tool_version: number; permission: string }
    const manifest = getCurrentPlatformTool(row.tool_key, row.tool_version)
    if (!manifest) {
      const latest = getCurrentPlatformTool(row.tool_key)
      checks.push({
        path: `grants.${row.tool_key}`,
        code: latest ? 'STALE_TOOL_VERSION' : 'UNKNOWN_TOOL',
        message: latest
          ? `Tool ${row.tool_key}@${row.tool_version} is no longer a supported frozen version; latest registered version is ${latest.version}.`
          : `Tool ${row.tool_key} is not registered.`,
        severity: 'error',
      })
    } else if (manifest.permission !== row.permission) {
      checks.push({ path: `grants.${row.tool_key}`, code: 'TOOL_PERMISSION_MISMATCH', message: `Grant permission ${row.permission} does not match the platform contract for ${row.tool_key}.`, severity: 'error' })
    } else if (expectedPlane && !manifest.allowedPlanes.includes(expectedPlane)) {
      checks.push({
        path: `grants.${row.tool_key}`,
        code: 'TOOL_PLANE_MISMATCH',
        message: `Tool ${row.tool_key} is not allowed on the ${expectedPlane} plane used by this agent purpose.`,
        severity: 'error',
      })
    }
  }

  const conflicts = analyzeRouteConflicts({
    routes: (routesRes.data ?? []) as never,
    agents: agent ? [{ id: agentId, status: agent.status as never, purpose: agent.purpose as never }] : [],
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
