import type { ToolDefinition } from '../../runtime/tool-registry'
import {
  assertValidToolManifest,
  type PlatformToolManifest,
  type PlatformToolPermission,
} from './contracts'

export type LegacyToolPlatformMetadata = Omit<
  PlatformToolManifest,
  'key' | 'version' | 'description' | 'inputSchema' | 'outputSchema' | 'permission'
> & {
  permission: PlatformToolPermission
}

/**
 * Transitional bridge for the tools that shipped before the platform manifest.
 *
 * The legacy registry remains the source of provider argument/return schemas
 * while the platform manifest becomes the source of authorization semantics,
 * usage guidance, side-effect classification, and extension contracts.
 * New domains MUST define native PlatformToolManifest objects directly.
 */
export function platformManifestFromLegacy(
  legacy: ToolDefinition,
  metadata: LegacyToolPlatformMetadata,
): PlatformToolManifest {
  if (!legacy.grantPermissions.includes(metadata.permission)) {
    throw new Error(
      `Legacy tool ${legacy.key}@${legacy.version} does not allow permission ${metadata.permission}`,
    )
  }

  return assertValidToolManifest({
    key: legacy.key,
    version: legacy.version,
    domain: metadata.domain,
    title: metadata.title,
    description: legacy.description,
    purpose: metadata.purpose,
    whenToUse: metadata.whenToUse,
    whenNotToUse: metadata.whenNotToUse,
    inputSchema: legacy.argumentSchema as Readonly<Record<string, unknown>>,
    outputSchema: { description: legacy.returnSchema },
    permission: metadata.permission,
    risk: metadata.risk,
    allowedPlanes: metadata.allowedPlanes,
    requiredCapabilities: metadata.requiredCapabilities,
    supportedGrantConstraints: metadata.supportedGrantConstraints,
    sideEffect: metadata.sideEffect,
    approvalRequired: metadata.approvalRequired,
    idempotent: metadata.idempotent,
    audit: metadata.audit,
    modelExposed: metadata.modelExposed,
    serverOnly: metadata.serverOnly,
    examples: metadata.examples,
    errorContract: metadata.errorContract,
  })
}
