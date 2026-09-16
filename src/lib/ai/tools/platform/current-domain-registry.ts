import { getRegisteredTool } from '../../runtime/tool-registry'
import { DomainRegistry, defineDomain } from './domain-registry'
import { platformManifestFromLegacy, type LegacyToolPlatformMetadata } from './legacy-bridge'
import type { PlatformToolManifest, PlatformToolPlane, PlatformToolPermission, PlatformToolRisk } from './contracts'

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

const SPECS: readonly CurrentToolSpec[] = [
  {
    key: 'services.search', version: 1, domain: 'services', title: 'Search services', permission: 'read', risk: 'read',
    planes: ['customer', 'admin'], capability: 'services.read', purpose: 'Find active catalog services relevant to a request.',
    use: ['The user needs to discover which configured service may fit their need.'],
    avoid: ['Do not use it to create, edit, price, or activate a service.'],
  },
  {
    key: 'services.get', version: 1, domain: 'services', title: 'Read service', permission: 'read', risk: 'read',
    planes: ['customer', 'admin'], capability: 'services.read', purpose: 'Read one configured service using model-safe fields.',
    use: ['A service id/code is known and its current public/AI-safe details are needed.'],
    avoid: ['Do not infer internal fields or use the result as authority to mutate the catalog.'],
  },
  {
    key: 'services.match_request', version: 1, domain: 'services', title: 'Match service request', permission: 'read', risk: 'read',
    planes: ['customer', 'admin'], capability: 'services.read', purpose: 'Classify a request against configured service schemas.',
    use: ['The conversation describes a service need but the exact configured service is not yet known.'],
    avoid: ['Do not promise a service when the match is none or required fields are missing.'],
  },
  {
    key: 'services.propose_update', version: 1, domain: 'services', title: 'Propose service update', permission: 'propose', risk: 'high',
    planes: ['admin'], capability: 'services.propose', purpose: 'Create a typed, reviewable proposal for a service revision.',
    use: ['A trusted administrator explicitly asks to change allowed service data.'],
    avoid: ['Never use for a customer request or to edit internal-only fields outside the typed schema.'], approval: true,
  },
  {
    key: 'pricing.calculate_quote', version: 1, domain: 'pricing', title: 'Calculate quote', permission: 'read', risk: 'read',
    planes: ['customer', 'admin'], capability: 'pricing.read', purpose: 'Calculate a quote from the currently published pricing rule.',
    use: ['The service, amount, currency, and required pricing attributes are known.'],
    avoid: ['Do not invent missing inputs or use it to modify a pricing rule.'], constraints: ['service_ids', 'currencies'],
  },
  {
    key: 'pricing_rules.propose_service_price', version: 1, domain: 'pricing_rules', title: 'Propose service price', permission: 'propose', risk: 'high',
    planes: ['admin'], capability: 'pricing.propose', purpose: 'Create a typed proposal for a new immutable pricing rule/service revision.',
    use: ['A trusted administrator explicitly supplies a pricing change.'],
    avoid: ['Never expose it to customers and never directly overwrite the live pricing row.'], approval: true,
  },
  {
    key: 'exchange_rates.get_current', version: 1, domain: 'exchange_rates', title: 'Read current exchange rate', permission: 'read', risk: 'read',
    planes: ['customer', 'admin'], capability: 'rates.read', purpose: 'Read the currently published rate for a buy/sell context.',
    use: ['A customer or admin asks for the current rate for a known currency pair and trade side.'],
    avoid: ['Do not use it to change rates or silently swap the customer buy/sell side.'], constraints: ['currencies'],
  },
  {
    key: 'exchange_rates.record_trade_request', version: 1, domain: 'exchange_rates', title: 'Record customer FX trade request', permission: 'propose', risk: 'medium',
    planes: ['customer'], capability: 'rates.trade_request', purpose: 'Record and forward the current customer’s request to buy/sell currency.',
    use: ['The customer wants to buy or sell currency and the amount/pair/side are understood.'],
    avoid: ['Never use it to change an exchange rate; customer identity comes only from server context.'], constraints: ['currencies'],
  },
  {
    key: 'exchange_rates.admin_list_books', version: 1, domain: 'exchange_rates', title: 'List rate books', permission: 'read', risk: 'read',
    planes: ['admin'], capability: 'rates.read', purpose: 'Inspect configured rate books and their current published versions.',
    use: ['A trusted administrator asks what rate books/versions are currently available.'],
    avoid: ['Do not use it as a write operation.'],
  },
  {
    key: 'exchange_rates.propose_pair_change', version: 1, domain: 'exchange_rates', title: 'Propose exchange-rate change', permission: 'propose', risk: 'high',
    planes: ['admin'], capability: 'rates.propose', purpose: 'Propose a versioned change to one exchange-rate pair.',
    use: ['A trusted administrator explicitly instructs a rate change with pair and rates.'],
    avoid: ['Never expose to customer plane; never bypass approval or version checks.'], constraints: ['currencies'], approval: true,
  },
  {
    key: 'coverage.check_availability', version: 1, domain: 'coverage', title: 'Check coverage availability', permission: 'read', risk: 'read',
    planes: ['customer', 'admin'], capability: 'coverage.read', purpose: 'Read aggregate coverage headroom without exposing provider internals.',
    use: ['The service/currency/required amount are known and availability needs checking.'],
    avoid: ['Do not reveal provider identity/internal cost to customer plane.'], constraints: ['service_ids', 'currencies'],
  },
  {
    key: 'coverage.find_offers', version: 2, domain: 'coverage', title: 'Find coverage offers', permission: 'read', risk: 'read',
    planes: ['customer', 'admin'], capability: 'coverage.read',
    purpose: 'Search canonical coverage supply using the CUSTOMER pay and receive legs. PAY is where/how the customer hands money to the business; RECEIVE is where/how the customer gets the covered amount. Arabic verbs such as سأسلم/أدفع/أسدد identify PAY; أستلم/استلام identify RECEIVE.',
    use: ['Use when both customer legs are understood. A north-pay to south-receive request matches anti-parallel south-pay to north-receive offers. If wording conflicts, clarify before searching.'],
    avoid: ['Never swap the legs because of word order. Do not interpret "سأسلم المبلغ ... في صنعاء" as receiving in صنعاء. Do not use a south-pay to north-receive customer case as a request; that direction is an offer. Never expose provider identity/internal cost on customer plane.'], constraints: ['service_ids', 'currencies'],
  },
  {
    key: 'coverage.get_rates', version: 1, domain: 'coverage', title: 'Resolve coverage direction and quote commission', permission: 'read', risk: 'read',
    planes: ['customer', 'admin'], capability: 'coverage.read',
    purpose: 'Resolve customer pay/receive regions, classify the canonical north/south coverage direction, read the published rate, and calculate commission. PAY is where/how the customer hands money to the business; RECEIVE is where/how the customer gets the covered amount.',
    use: ['Use first for a concrete coverage question. Explicit Arabic سأسلم/أدفع/أسدد means CUSTOMER PAY; أستلم/استلام means CUSTOMER RECEIVE. South-pay to north-receive is an offer with commission returned; north-pay to south-receive is a request with commission paid by customer.'],
    avoid: ['Never swap pay/receive from word order or from the words راجع/عمولة. If explicit wording and inferred legs disagree, ask a concise clarification instead of quoting. Do not invent a missing unpublished rate.'],
  },
  {
    key: 'coverage.propose_offer', version: 2, domain: 'coverage', title: 'Forward canonical coverage offer', permission: 'propose', risk: 'medium',
    planes: ['customer'], capability: 'coverage.propose',
    purpose: 'Create a typed approval proposal for the canonical domestic south-pay to north-receive coverage direction; the server verifies direction and snapshots the published rate.',
    use: ['The customer pays in the south and receives in the north, both resolved region ids are known, and the customer has confirmed the offer.'],
    avoid: ['Never swap customer pay/receive legs. Explicit سأسلم/أدفع/أسدد refers to PAY; أستلم/استلام refers to RECEIVE. Never classify from wording alone, never let the model choose customer identity, and never trust a model-supplied commission over the published board.'], constraints: ['service_ids', 'currencies'],
  },
  {
    key: 'coverage.propose_request', version: 1, domain: 'coverage', title: 'Forward canonical coverage request', permission: 'propose', risk: 'medium',
    planes: ['customer'], capability: 'coverage.propose',
    purpose: 'Create a typed approval proposal for the canonical domestic north-pay to south-receive coverage direction; the server verifies direction and snapshots the published rate.',
    use: ['The customer pays in the north and receives in the south, both resolved region ids are known, and the customer has confirmed the request.'],
    avoid: ['Never swap customer pay/receive legs. Explicit سأسلم/أدفع/أسدد refers to PAY; أستلم/استلام refers to RECEIVE. Never classify from wording alone, never let the model choose customer identity, and never trust a model-supplied commission over the published board.'], constraints: ['service_ids', 'currencies'],
  },
  {
    key: 'coverage.admin_list_offers', version: 1, domain: 'coverage', title: 'List coverage offers for admin', permission: 'read', risk: 'read',
    planes: ['admin'], capability: 'coverage.read', purpose: 'Give trusted administration the operational offer view.',
    use: ['Administration asks for available offers, providers, or operational offer status.'],
    avoid: ['Never expose this internal DTO on the customer plane.'],
  },
  {
    key: 'coverage.admin_list_requests', version: 1, domain: 'coverage', title: 'List coverage requests for admin', permission: 'read', risk: 'read',
    planes: ['admin'], capability: 'coverage.read', purpose: 'Give trusted administration the operational request view.',
    use: ['Administration asks for incoming or current coverage requests.'],
    avoid: ['Never expose this internal DTO on the customer plane.'],
  },
  {
    key: 'intents.record', version: 1, domain: 'intents', title: 'Record customer intent', permission: 'propose', risk: 'low',
    planes: ['customer', 'admin'], capability: 'intents.propose', purpose: 'Persist a structured need/offer the configured services cannot yet resolve.',
    use: ['A business need/offer should be remembered or forwarded for review.'],
    avoid: ['Do not treat a generic intent as an approved authoritative mutation.'],
  },
  {
    key: 'intents.search', version: 1, domain: 'intents', title: 'Search customer intents', permission: 'read', risk: 'read',
    planes: ['admin'], capability: 'intents.read', purpose: 'Inspect the structured admin inbox of customer needs/offers.',
    use: ['Administration asks what customer requests/offers are waiting or recorded.'],
    avoid: ['Do not expose the administrative intent queue to customer plane.'],
  },
  {
    key: 'intents.propose_decision', version: 1, domain: 'intents', title: 'Propose intent decision', permission: 'propose', risk: 'medium',
    planes: ['admin'], capability: 'intents.propose', purpose: 'Create a typed proposal to resolve/match/reject/clarify a customer intent.',
    use: ['A trusted administrator has reviewed an intent and instructs a decision.'],
    avoid: ['Do not resolve a customer intent without the explicit admin decision.'],
  },
  {
    key: 'change_requests.list_pending', version: 1, domain: 'change_requests', title: 'List pending changes', permission: 'read', risk: 'read',
    planes: ['admin'], capability: 'change_requests.read', purpose: 'Inspect pending typed proposals awaiting a human decision.',
    use: ['A trusted administrator asks what changes await approval.'],
    avoid: ['Do not interpret listing a proposal as approving it.'],
  },
]

const commonErrors = [
  { code: 'INVALID_INPUT', safeToShow: true, meaning: 'Arguments failed the tool schema or business validation.' },
  { code: 'FORBIDDEN', safeToShow: false, meaning: 'Runtime plane/capability/grant policy denied the invocation.' },
  { code: 'NOT_FOUND', safeToShow: true, meaning: 'The requested account-scoped resource was not found.' },
  { code: 'INTERNAL_ERROR', safeToShow: false, meaning: 'The operation failed without exposing internal details.' },
] as const

function build(spec: CurrentToolSpec): PlatformToolManifest {
  const legacy = getRegisteredTool(spec.key)
  if (!legacy || legacy.version !== spec.version) {
    throw new Error(`Platform contract is missing matching legacy tool ${spec.key}@${spec.version}`)
  }
  const sideEffect = spec.permission === 'read' ? 'none' : spec.permission === 'propose' ? 'proposal' : 'authoritative_write'
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
    errorContract: commonErrors,
  }
  return platformManifestFromLegacy(legacy, metadata)
}

const manifests = SPECS.map(build)
const byDomain = new Map<string, PlatformToolManifest[]>()
for (const tool of manifests) {
  const list = byDomain.get(tool.domain) ?? []
  list.push(tool)
  byDomain.set(tool.domain, list)
}

export const CURRENT_PLATFORM_REGISTRY = new DomainRegistry()
for (const [domain, tools] of byDomain) {
  CURRENT_PLATFORM_REGISTRY.register(defineDomain({
    key: domain,
    version: 1,
    title: domain.replaceAll('_', ' '),
    description: `WACRM ${domain} tool domain.`,
    capabilities: [...new Set(tools.flatMap((tool) => tool.requiredCapabilities))],
    tools,
  }))
}

export function getCurrentPlatformTool(key: string, version?: number): PlatformToolManifest | null {
  if (version != null) return CURRENT_PLATFORM_REGISTRY.getTool(key, version)
  const matches = CURRENT_PLATFORM_REGISTRY.listTools().filter((tool) => tool.key === key)
  return matches.sort((a, b) => b.version - a.version)[0] ?? null
}
