import { getCurrentPlatformTool } from '../tools/platform/current-domain-registry'
import type {
  AgentPurpose,
  AgentTrustClass,
  RunPlane,
} from './multi-agent-types'

export type { AgentPurpose, AgentTrustClass } from './multi-agent-types'
export type AgentPlane = RunPlane

export interface InheritedToolGrant {
  tool_key: string
  tool_version: number
  permission: string
}

export interface GrantPlaneCompatibility {
  allowed: boolean
  plane: AgentPlane | null
  reason: 'allowed' | 'tool_policy_missing' | 'permission_mismatch' | 'plane_mismatch'
}

export function trustClassForAgentPurpose(
  purpose: AgentPurpose,
): AgentTrustClass {
  if (purpose === 'admin_operations') return 'admin'
  // A custom business role never implies elevated trust. Until trust class is
  // persisted explicitly, custom agents inherit the external/customer-safe
  // posture.
  return 'external'
}

export function planeForAgentPurpose(purpose: AgentPurpose): AgentPlane {
  return trustClassForAgentPurpose(purpose) === 'admin' ? 'admin' : 'customer'
}

/**
 * Decide whether an existing grant can be inherited by a new draft for the
 * agent purpose. The platform manifest is authoritative: old published
 * revisions may contain grants from before plane validation was introduced,
 * but those legacy grants must not contaminate new editable drafts.
 *
 * `custom` agents are external/customer-safe by default. This prevents a
 * custom purpose string from becoming an implicit bypass around the admin
 * plane boundary.
 */
export function inheritedGrantAllowedForPurpose(
  grant: InheritedToolGrant,
  purpose: AgentPurpose,
): GrantPlaneCompatibility {
  const plane = planeForAgentPurpose(purpose)
  const manifest = getCurrentPlatformTool(grant.tool_key, grant.tool_version)

  if (!manifest) {
    return { allowed: false, plane, reason: 'tool_policy_missing' }
  }
  if (manifest.permission !== grant.permission) {
    return { allowed: false, plane, reason: 'permission_mismatch' }
  }
  if (plane && !manifest.allowedPlanes.includes(plane)) {
    return { allowed: false, plane, reason: 'plane_mismatch' }
  }
  return { allowed: true, plane, reason: 'allowed' }
}
