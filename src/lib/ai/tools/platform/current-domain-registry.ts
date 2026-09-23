import { CURRENT_BUSINESS_DOMAIN_MODULES } from '@/lib/services/platform/domain-catalog'
import { STANDARD_PLATFORM_TOOL_ERRORS } from '@/lib/services/platform/tool-contract-defaults'
import { getRegisteredTool } from '../../runtime/tool-registry'
import type {
  PlatformToolManifest,
  PlatformToolPlane,
  PlatformToolPermission,
  PlatformToolRisk,
} from './contracts'
import { DomainRegistry, defineDomain } from './domain-registry'
import {
  platformManifestFromLegacy,
  type LegacyToolPlatformMetadata,
} from './legacy-bridge'

type CurrentToolSpec = {
  key: string
  version: number
  domain: string
  title: string
  permission: PlatformToolPermission
  risk: PlatformToolRisk
  planes: readonly PlatformToolPlane[]
  capability: string
  purpose: string
  use: readonly string[]
  avoid: readonly string[]
  constraints?: readonly string[]
  approval?: boolean
}

/**
 * Transitional legacy specs only.
 *
 * Business domains registered in the shared domain catalog are intentionally
 * absent: their native PlatformToolManifest objects live with the owners.
 */
const LEGACY_SPECS: readonly CurrentToolSpec[] = [
  {
    key: 'services.search',
    version: 1,
    domain: 'services',
    title: 'Search services',
    permission: 'read',
    risk: 'read',
    planes: ['customer', 'admin'],
    capability: 'services.read',
    purpose: 'Find active catalog services relevant to a request.',
    use: ['The user needs to discover which configured service may fit their need.'],
    avoid: ['Do not use it to create, edit, price, or activate a service.'],
  },
  {
    key: 'services.get',
    version: 1,
    domain: 'services',
    title: 'Read service',
    permission: 'read',
    risk: 'read',
    planes: ['customer', 'admin'],
    capability: 'services.read',
    purpose: 'Read one configured service using model-safe fields.',
    use: ['A service id/code is known and its current public/AI-safe details are needed.'],
    avoid: ['Do not infer internal fields or use the result as authority to mutate the catalog.'],
  },
  {
    key: 'services.match_request',
    version: 1,
    domain: 'services',
    title: 'Match service request',
    permission: 'read',
    risk: 'read',
    planes: ['customer', 'admin'],
    capability: 'services.read',
    purpose: 'Classify a request against configured service schemas.',
    use: ['The conversation describes a service need but the exact configured service is not yet known.'],
    avoid: ['Do not promise a service when the match is none or required fields are missing.'],
  },
  {
    key: 'services.propose_update',
    version: 1,
    domain: 'services',
    title: 'Propose service update',
    permission: 'propose',
    risk: 'high',
    planes: ['admin'],
    capability: 'services.propose',
    purpose: 'Create a typed, reviewable proposal for a service revision.',
    use: ['A trusted administrator explicitly asks to change allowed service data.'],
    avoid: ['Never use for a customer request or to edit internal-only fields outside the typed schema.'],
    approval: true,
  },
  {
    key: 'pricing.calculate_quote',
    version: 1,
    domain: 'pricing',
    title: 'Calculate quote',
    permission: 'read',
    risk: 'read',
    planes: ['customer', 'admin'],
    capability: 'pricing.read',
    purpose: 'Calculate a quote from the currently published pricing rule.',
    use: ['The service, amount, currency, and required pricing attributes are known.'],
    avoid: ['Do not invent missing inputs or use it to modify a pricing rule.'],
    constraints: ['service_ids', 'currencies'],
  },
  {
    key: 'pricing_rules.propose_service_price',
    version: 1,
    domain: 'pricing_rules',
    title: 'Propose service price',
    permission: 'propose',
    risk: 'high',
    planes: ['admin'],
    capability: 'pricing.propose',
    purpose: 'Create a typed proposal for a new immutable pricing rule/service revision.',
    use: ['A trusted administrator explicitly supplies a pricing change.'],
    avoid: ['Never expose it to customers and never directly overwrite the live pricing row.'],
    approval: true,
  },
  {
    key: 'change_requests.list_pending',
    version: 1,
    domain: 'change_requests',
    title: 'List pending changes',
    permission: 'read',
    risk: 'read',
    planes: ['admin'],
    capability: 'change_requests.read',
    purpose: 'Inspect pending typed proposals awaiting a human decision.',
    use: ['A trusted administrator asks what changes await approval.'],
    avoid: ['Do not interpret listing a proposal as approving it.'],
  },
]

function buildLegacy(spec: CurrentToolSpec): PlatformToolManifest {
  const legacy = getRegisteredTool(spec.key)
  if (!legacy || legacy.version !== spec.version) {
    throw new Error(
      `Platform contract is missing matching legacy tool ${spec.key}@${spec.version}`,
    )
  }

  const sideEffect =
    spec.permission === 'read'
      ? 'none'
      : spec.permission === 'propose'
        ? 'proposal'
        : 'authoritative_write'

  const metadata: LegacyToolPlatformMetadata = {
    domain: spec.domain,
    title: spec.title,
    purpose: spec.purpose,
    whenToUse: spec.use,
    whenNotToUse: spec.avoid,
    permission: spec.permission,
    risk: spec.risk,
    allowedPlanes: spec.planes,
    requiredCapabilities: [spec.capability],
    supportedGrantConstraints: spec.constraints ?? ['channels'],
    sideEffect,
    approvalRequired: spec.approval ?? false,
    idempotent: true,
    audit: spec.permission === 'read' ? 'invocation' : 'proposal_and_execution',
    modelExposed: spec.permission !== 'execute',
    serverOnly: spec.permission === 'execute',
    examples: [],
    errorContract: STANDARD_PLATFORM_TOOL_ERRORS,
  }

  return platformManifestFromLegacy(legacy, metadata)
}

const legacyByDomain = new Map<string, PlatformToolManifest[]>()
for (const tool of LEGACY_SPECS.map(buildLegacy)) {
  const list = legacyByDomain.get(tool.domain) ?? []
  list.push(tool)
  legacyByDomain.set(tool.domain, list)
}

export const CURRENT_PLATFORM_REGISTRY = new DomainRegistry()

for (const [domain, tools] of legacyByDomain) {
  CURRENT_PLATFORM_REGISTRY.register(
    defineDomain({
      key: domain,
      version: 1,
      title: domain.replaceAll('_', ' '),
      description: `WACRM ${domain} transitional tool domain.`,
      capabilities: [...new Set(tools.flatMap((tool) => tool.requiredCapabilities))],
      tools,
    }),
  )
}

for (const domain of CURRENT_BUSINESS_DOMAIN_MODULES) {
  CURRENT_PLATFORM_REGISTRY.register(
    defineDomain({
      key: domain.key,
      version: domain.version,
      title: domain.title,
      description: domain.description,
      capabilities: domain.capabilities,
      tools: domain.tools,
    }),
  )
}

export function getCurrentPlatformTool(
  key: string,
  version?: number,
): PlatformToolManifest | null {
  if (version != null) return CURRENT_PLATFORM_REGISTRY.getTool(key, version)
  const matches = CURRENT_PLATFORM_REGISTRY.listTools().filter((tool) => tool.key === key)
  return matches.sort((a, b) => b.version - a.version)[0] ?? null
}
