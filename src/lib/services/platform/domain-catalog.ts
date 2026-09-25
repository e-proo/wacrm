import { COVERAGE_DOMAIN, COVERAGE_RUNTIME } from '@/lib/services/coverage/domain'
import { FX_V2_DOMAIN, FX_V2_RUNTIME } from '@/lib/services/fx-v2/domain'
import { INTENTS_DOMAIN, INTENTS_RUNTIME } from '@/lib/services/intents/domain'
import { SERVICES_DOMAIN, SERVICES_RUNTIME } from '@/lib/services/service-catalog/domain'
import { PRICING_DOMAIN, PRICING_RUNTIME } from '@/lib/services/pricing/domain'
import { PRICING_RULES_DOMAIN, PRICING_RULES_RUNTIME } from '@/lib/services/pricing-rules/domain'
import type { BusinessDomainManifest } from './domain-contracts'

/**
 * Single composition root for business domains.
 *
 * Adding a new domain should require registering its manifest/runtime here,
 * not adding branches to AI runtime, change execution, notification delivery,
 * template resolution, or tool dispatch.
 */
export const CURRENT_BUSINESS_DOMAIN_MODULES: readonly BusinessDomainManifest[] = [
  FX_V2_DOMAIN,
  COVERAGE_DOMAIN,
  INTENTS_DOMAIN,
  SERVICES_DOMAIN,
  PRICING_DOMAIN,
  PRICING_RULES_DOMAIN,
]

export const CURRENT_BUSINESS_DOMAIN_RUNTIMES = [
  FX_V2_RUNTIME,
  COVERAGE_RUNTIME,
  INTENTS_RUNTIME,
  SERVICES_RUNTIME,
  PRICING_RUNTIME,
  PRICING_RULES_RUNTIME,
] as const
