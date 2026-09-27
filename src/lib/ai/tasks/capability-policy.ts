import type { SupabaseClient } from '@supabase/supabase-js'
import { getCurrentPlatformTool } from '../tools/platform/current-domain-registry'
import type {
  AgentTaskAllowedTool,
  AgentTaskTypeManifest,
} from './contracts'

export const PLATFORM_AGENT_CAPABILITIES = [
  'agent_tasks.read',
  'agent_tasks.manage',
  'outreach.read',
  'outreach.start',
  'outreach.pause',
  'contacts.target_read',
] as const

export const BASE_OUTBOUND_AGENT_CAPABILITIES = [
  'agent_tasks.read',
  'outreach.start',
  'contacts.target_read',
] as const

export type PlatformAgentCapability =
  (typeof PLATFORM_AGENT_CAPABILITIES)[number]

export interface AgentRevisionToolGrant {
  toolKey: string
  toolVersion: number
  permission: 'read' | 'propose' | 'execute'
}

export type AgentTaskExecutionAuthorization =
  | {
      ok: true
      capabilities: readonly string[]
      allowedTools: readonly AgentTaskAllowedTool[]
    }
  | {
      ok: false
      code:
        | 'TASK_TYPE_NOT_REGISTERED'
        | 'AGENT_CAPABILITY_MISSING'
        | 'TASK_TOOL_POLICY_INVALID'
      message: string
      missingCapabilities?: readonly string[]
    }

const CAPABILITY_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/

export function isAgentCapabilityKey(value: unknown): value is string {
  return typeof value === 'string' && CAPABILITY_RE.test(value)
}

/**
 * Validate the Task Manifest's maximum tool scope against the canonical
 * Platform Tool Registry.
 *
 * Agent Tasks currently execute on the customer plane. Every allowed tool must
 * therefore be a model-exposed READ/PROPOSE tool that is explicitly allowed on
 * the customer plane. A raw messaging/send tool must never enter this scope;
 * outbound delivery is a deterministic platform effect owned by the
 * orchestrator/message policy.
 */
export function validateTaskManifestToolPolicy(
  manifest: AgentTaskTypeManifest,
): readonly string[] {
  const issues: string[] = []

  for (const capability of manifest.requiredAgentCapabilities) {
    if (!isAgentCapabilityKey(capability)) {
      issues.push(`INVALID_AGENT_CAPABILITY:${capability}`)
    }
  }

  for (const allowed of manifest.allowedTools) {
    const tool = getCurrentPlatformTool(allowed.key, allowed.version)
    const id = `${allowed.key}@${allowed.version}`

    if (!tool) {
      issues.push(`TASK_TOOL_NOT_REGISTERED:${id}`)
      continue
    }
    if (!tool.modelExposed || tool.serverOnly || tool.permission === 'execute') {
      issues.push(`TASK_TOOL_NOT_MODEL_SAFE:${id}`)
    }
    if (!tool.allowedPlanes.includes('customer')) {
      issues.push(`TASK_TOOL_CUSTOMER_PLANE_DENIED:${id}`)
    }
    if (
      /^(?:whatsapp|messaging|messages|outreach)\.(?:send|send_|deliver|dispatch)/.test(
        tool.key,
      )
    ) {
      issues.push(`TASK_RAW_SEND_TOOL_FORBIDDEN:${id}`)
    }
  }

  return issues
}

/**
 * Authorize one frozen Agent Revision for one Task Type.
 *
 * The effective model tool set is the intersection:
 *
 *   revision grants
 *   ∩ task manifest allowedTools
 *   ∩ platform manifest safety/plane rules
 *   ∩ revision capability grants
 *
 * Missing optional tool grants simply reduce the effective tool set. Missing
 * platform/domain capabilities fail the task closed before any target/model
 * work begins.
 */
export function authorizeAgentRevisionForTask(input: {
  manifest: AgentTaskTypeManifest
  revisionCapabilities: readonly string[]
  revisionToolGrants: readonly AgentRevisionToolGrant[]
}): AgentTaskExecutionAuthorization {
  const manifestIssues = validateTaskManifestToolPolicy(input.manifest)
  if (manifestIssues.length > 0) {
    return {
      ok: false,
      code: 'TASK_TOOL_POLICY_INVALID',
      message: manifestIssues.join('; '),
    }
  }

  const capabilities = new Set(input.revisionCapabilities)
  const required = new Set<string>([
    ...BASE_OUTBOUND_AGENT_CAPABILITIES,
    ...input.manifest.requiredAgentCapabilities,
  ])

  const allowedById = new Map(
    input.manifest.allowedTools.map((tool) => [
      `${tool.key}@${tool.version}`,
      tool,
    ]),
  )

  const effectiveTools: AgentTaskAllowedTool[] = []
  for (const grant of input.revisionToolGrants) {
    const id = `${grant.toolKey}@${grant.toolVersion}`
    const allowed = allowedById.get(id)
    if (!allowed) continue

    const tool = getCurrentPlatformTool(grant.toolKey, grant.toolVersion)
    if (!tool || tool.permission !== grant.permission) {
      return {
        ok: false,
        code: 'TASK_TOOL_POLICY_INVALID',
        message: `Frozen tool grant does not match the platform contract: ${id}`,
      }
    }

    for (const capability of tool.requiredCapabilities) {
      required.add(capability)
    }
    effectiveTools.push(allowed)
  }

  const missing = [...required].filter(
    (capability) => !capabilities.has(capability),
  )
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'AGENT_CAPABILITY_MISSING',
      message: `Agent revision is missing required capabilities: ${missing.join(', ')}`,
      missingCapabilities: missing,
    }
  }

  return {
    ok: true,
    capabilities: Object.freeze([...capabilities]),
    allowedTools: Object.freeze(
      effectiveTools.map((tool) => Object.freeze({ ...tool })),
    ),
  }
}

export async function loadAgentRevisionCapabilities(
  db: SupabaseClient,
  input: { accountId: string; revisionId: string },
): Promise<readonly string[]> {
  const { data, error } = await db
    .from('ai_agent_revision_capabilities')
    .select('capability')
    .eq('account_id', input.accountId)
    .eq('agent_revision_id', input.revisionId)
    .order('capability', { ascending: true })

  if (error) throw error
  return Object.freeze(
    (data ?? [])
      .map((row) => (row as { capability: string }).capability)
      .filter(isAgentCapabilityKey),
  )
}

export async function loadAgentRevisionToolGrants(
  db: SupabaseClient,
  input: { accountId: string; revisionId: string },
): Promise<readonly AgentRevisionToolGrant[]> {
  const { data, error } = await db
    .from('ai_agent_tool_grants')
    .select('tool_key, tool_version, permission')
    .eq('account_id', input.accountId)
    .eq('agent_revision_id', input.revisionId)

  if (error) throw error
  return Object.freeze(
    (data ?? []).map((row) => {
      const value = row as {
        tool_key: string
        tool_version: number
        permission: 'read' | 'propose' | 'execute'
      }
      return Object.freeze({
        toolKey: value.tool_key,
        toolVersion: value.tool_version,
        permission: value.permission,
      })
    }),
  )
}
