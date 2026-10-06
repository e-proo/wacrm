import { CURRENT_BUSINESS_DOMAIN_MODULES } from '@/lib/services/platform/domain-catalog'
import { DomainRegistry, defineDomain } from './domain-registry'

export const CURRENT_PLATFORM_REGISTRY = new DomainRegistry()

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
) {
  if (version != null) return CURRENT_PLATFORM_REGISTRY.getTool(key, version)
  const matches = CURRENT_PLATFORM_REGISTRY.listTools().filter((tool) => tool.key === key)
  return matches.sort((a, b) => b.version - a.version)[0] ?? null
}
