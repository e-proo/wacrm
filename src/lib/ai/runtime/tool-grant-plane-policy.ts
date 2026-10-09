import { getCurrentPlatformTool } from '../tools/platform/current-domain-registry'

export type AgentPurpose = 'customer_support' | 'admin_operations' | 'custom'
export type AgentPlane = 'customer' | 'admin'

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

export function planeForAgentPurpose(purpose: AgentPurpose): AgentPlane | null {
  if (purpose === 'customer_support') return 'customer'
  if (purpose === 'admin_operations') return 'admin'
  return null
}

/**
 * Decide whether an existing grant can be inherited by a new draft for the
 * agent purpose. The platform manifest is authoritative: old published
 * revisions may contain grants from before plane validation was introduced,
 * but those legacy grants must not contaminate new editable drafts.
 *
 * `custom` agents have no fixed plane ceiling here; publish-time validation
 * remains authoritative for every other grant invariant.
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
