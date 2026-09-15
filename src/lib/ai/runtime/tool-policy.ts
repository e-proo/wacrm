import type { AgentPurpose, ToolGrantPermission, RunPlane } from './multi-agent-types'
import type { ToolDefinition } from './tool-registry'
import { getCurrentPlatformTool } from '../tools/platform/current-domain-registry'

export interface RuntimeFeaturePolicy {
  killSwitch: boolean
  nativeToolsEnabled: boolean
  proposalToolsEnabled: boolean
}

export interface ToolAuthorizationContext {
  plane: RunPlane
  channel: 'whatsapp'
  simulation: boolean
  agentPurpose: AgentPurpose
  trustedAdminIdentityId: string | null
  trustedAdminCapabilities: ReadonlyArray<string>
  features: RuntimeFeaturePolicy
}

// Tool semantics live in the canonical platform manifest. The runtime policy
// only enforces the manifest + frozen grant + verified identity intersection;
// it does not maintain a second hand-written allowlist.

export function authorizeToolInvocation(input: {
  tool: ToolDefinition
  permission: ToolGrantPermission
  args: Record<string, unknown>
  constraints: Record<string, unknown>
  context: ToolAuthorizationContext
}): { ok: true } | { ok: false; code: string; message: string } {
  const { tool, permission, args, constraints, context } = input
  if (context.features.killSwitch) return deny('AI_KILL_SWITCH', 'AI tools are disabled for this account.')
  if (!context.features.nativeToolsEnabled) return deny('NATIVE_TOOLS_DISABLED', 'Native tools are not enabled for this account.')
  if (context.channel !== 'whatsapp') return deny('TOOL_CHANNEL_DENIED', 'Tool is not allowed on this channel.')

  // Agent purpose is a security boundary, not prompt guidance.
  if (context.plane === 'admin' && context.agentPurpose !== 'admin_operations') {
    return deny('AGENT_PURPOSE_DENIED', 'Only an admin-operations agent may run on the admin plane.')
  }
  if (context.plane === 'customer' && context.agentPurpose === 'admin_operations') {
    return deny('AGENT_PURPOSE_DENIED', 'An admin-operations agent may not run on the customer plane.')
  }

  const manifest = getCurrentPlatformTool(tool.key, tool.version)
  if (!manifest) return deny('TOOL_POLICY_MISSING', `Tool "${tool.key}@${tool.version}" has no platform contract.`)
  if (manifest.permission !== permission) {
    return deny('TOOL_PERMISSION_MISMATCH', `Grant permission does not match the registered contract for "${tool.key}".`)
  }
  if (!manifest.allowedPlanes.includes(context.plane)) {
    return deny('TOOL_PLANE_DENIED', `Tool "${tool.key}" is not allowed on this plane.`)
  }

  // No model is ever allowed a direct write. Mutating operations must be
  // represented as a proposal and applied only after explicit approval.
  if (permission === 'execute') {
    return deny('DIRECT_WRITE_DENIED', 'Direct model writes are disabled. Use a change request.')
  }
  if (permission === 'propose' && !context.features.proposalToolsEnabled) {
    return deny('PROPOSAL_TOOLS_DISABLED', 'Proposal tools are disabled for this account.')
  }
  if (context.simulation && permission !== 'read') {
    return deny('SIMULATION_WRITE_DENIED', 'Simulation cannot create proposals or execute writes.')
  }

  // Customer-plane tools are authorized by the frozen revision grant +
  // account feature policy. Admin-plane tools additionally require the
  // verified person's capability intersection.
  if (context.plane === 'admin') {
    if (!context.trustedAdminIdentityId) return deny('TRUSTED_ADMIN_REQUIRED', 'Trusted admin identity is required.')
    const missing = manifest.requiredCapabilities.find(
      (capability) => !context.trustedAdminCapabilities.includes(capability),
    )
    if (missing) {
      return deny('ADMIN_CAPABILITY_DENIED', `Trusted admin lacks capability "${missing}".`)
    }
  }

  const constrained = enforceGrantConstraints(constraints, args, context.channel)
  if (!constrained.ok) return constrained
  return { ok: true }
}

function enforceGrantConstraints(
  constraints: Record<string, unknown>,
  args: Record<string, unknown>,
  channel: 'whatsapp',
): { ok: true } | { ok: false; code: string; message: string } {
  const keys = Object.keys(constraints)
  const supported = new Set(['channels', 'service_ids', 'currencies'])
  const unknown = keys.find((key) => !supported.has(key))
  if (unknown) {
    return deny(
      'GRANT_CONSTRAINT_UNSUPPORTED',
      `Grant constraint "${unknown}" is not enforced by this runtime; execution is denied.`,
    )
  }

  if (constraints.channels !== undefined) {
    if (!isStringArray(constraints.channels) || !constraints.channels.includes(channel)) {
      return deny('GRANT_CHANNEL_DENIED', 'This grant is not valid for the current channel.')
    }
  }

  if (constraints.service_ids !== undefined) {
    if (!isStringArray(constraints.service_ids)) {
      return deny('GRANT_CONSTRAINT_INVALID', 'service_ids must be an array of strings.')
    }
    const serviceId = typeof args.service_id === 'string' ? args.service_id : null
    if (!serviceId || !constraints.service_ids.includes(serviceId)) {
      return deny('GRANT_SERVICE_DENIED', 'This grant does not allow the requested service.')
    }
  }

  const allowedCurrencies = constraints.currencies
  if (allowedCurrencies !== undefined) {
    if (!isStringArray(allowedCurrencies)) {
      return deny('GRANT_CONSTRAINT_INVALID', 'currencies must be an array of strings.')
    }
    const currencyCandidates = [args.currency, args.base_currency, args.quote_currency]
      .filter((value): value is string => typeof value === 'string')
    if (currencyCandidates.length === 0 || currencyCandidates.some((value) => !allowedCurrencies.includes(value))) {
      return deny('GRANT_CURRENCY_DENIED', 'This grant does not allow the requested currency.')
    }
  }

  return { ok: true }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function deny(code: string, message: string) {
  return { ok: false as const, code, message }
}
