import type { ToolGrantPermission } from './multi-agent-types'

export type ToolEffect = 'read' | 'propose' | 'execute-internal'

export interface ToolDefinition {
  key: string
  version: number
  description: string
  notes?: string
  argumentSchema: Record<string, ArgumentSchema>
  returnSchema: string
  grantPermissions: ReadonlyArray<ToolGrantPermission>
  category: 'services' | 'pricing' | 'rates' | 'coverage' | 'intents' | 'changes'
  risk: 'read' | 'low' | 'medium' | 'high'
}

export interface ArgumentSchema {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'object'
  description: string
  values?: string[]
  required?: boolean
}

const SERVICES_SEARCH: ToolDefinition = {
  key: 'services.search', version: 1,
  description: 'Search the active services catalog. Returns name + public description + code.',
  argumentSchema: {
    query: { type: 'string', description: 'Free-text query; matches against name and code.', required: false },
    category_id: { type: 'string', description: 'Restrict to a specific category UUID.', required: false },
    limit: { type: 'number', description: 'Max results. Default 10, max 50.', required: false },
  },
  returnSchema: 'Array<{ id, name, code, category_id, public_description }>',
  grantPermissions: ['read'], category: 'services', risk: 'read',
}

const SERVICES_GET: ToolDefinition = {
  key: 'services.get', version: 1,
  description: 'Read a single service by id or code. Returns public fields only.',
  argumentSchema: {
    id_or_code: { type: 'string', description: 'Service UUID or internal code (e.g. COV-SANA-CASH).', required: true },
  },
  returnSchema: '{ id, name, code, status, public_description, field_values, pricing_quote }',
  grantPermissions: ['read'], category: 'services', risk: 'read',
}

const PRICING_CALCULATE_QUOTE: ToolDefinition = {
  key: 'pricing.calculate_quote', version: 1,
  description: 'Compute a fee for a service + amount. Returns fee amount + currency + rendered facts. Does NOT mutate state.',
  argumentSchema: {
    service_id: { type: 'string', description: 'Service UUID.', required: true },
    amount: { type: 'string', description: 'Amount as a decimal string (e.g. "10000.00").', required: true },
    currency: { type: 'string', description: 'ISO-4217-like 3-letter code.', required: true },
    attributes: { type: 'object', description: 'Service-specific attributes.', required: false },
  },
  returnSchema: 'QuoteResult { status, feeAmount, feeCurrency, renderedFacts, inputAmount, inputCurrency, precision, audit }',
  grantPermissions: ['read'], category: 'pricing', risk: 'read',
}

const SERVICES_MATCH_REQUEST: ToolDefinition = {
  key: 'services.match_request', version: 1,
  description: 'Match a customer request against equipped service schemas. Returns exact / partial / none with missing fields. NEVER prices or promises on "none" — escalate instead.',
  argumentSchema: {
    service_hint: { type: 'string', description: 'What the customer asked for, in a few words.', required: false },
    attributes: { type: 'object', description: 'What the agent understood from the customer, as key/value pairs.', required: true },
    limit: { type: 'number', description: 'Max candidates. Default 10, max 50.', required: false },
  },
  returnSchema: 'MatchResult { match: exact|partial|none, candidates: [{ service_id, name, classification, missing_fields, unknown_fields }] }',
  grantPermissions: ['read'], category: 'services', risk: 'read',
}

const CHANGE_REQUESTS_LIST_PENDING: ToolDefinition = {
  key: 'change_requests.list_pending', version: 1,
  description: 'Admin-only list of pending proposed system changes awaiting a human decision.',
  argumentSchema: { limit: { type: 'number', description: 'Default 20, max 100.', required: false } },
  returnSchema: 'Array<{ id, code, target_type, intent, summary, proposed_payload, created_at, expires_at }>',
  grantPermissions: ['read'], category: 'changes', risk: 'read',
}

const SERVICES_PROPOSE_UPDATE: ToolDefinition = {
  key: 'services.propose_update', version: 1,
  description: 'Admin-only proposal to publish a new service revision. Internal-only fields are preserved but never exposed to or editable by the model.',
  argumentSchema: {
    service_id: { type: 'string', description: 'Service UUID.', required: true },
    name: { type: 'string', description: 'Optional new service name.', required: false },
    public_description: { type: 'string', description: 'Optional new public description.', required: false },
    ai_guidance: { type: 'string', description: 'Optional AI guidance. Never customer-visible.', required: false },
    field_values_patch: { type: 'object', description: 'Patch to non-internal schema fields only.', required: false },
    pricing_rule_id: { type: 'string', description: 'Optional published pricing-rule UUID.', required: false },
    status: { type: 'enum', description: 'Optional service lifecycle state.', values: ['draft', 'active', 'paused', 'archived'], required: false },
  },
  returnSchema: '{ service, proposed, change_request }',
  grantPermissions: ['propose'], category: 'services', risk: 'high',
}

const PRICING_RULES_PROPOSE_SERVICE_PRICE: ToolDefinition = {
  key: 'pricing_rules.propose_service_price', version: 1,
  description: 'Admin-only proposal to create a new immutable pricing rule and attach it through a new service revision after approval.',
  argumentSchema: {
    service_id: { type: 'string', description: 'Service UUID.', required: true },
    name: { type: 'string', description: 'Pricing rule name.', required: true },
    kind: { type: 'enum', description: 'Pricing formula kind.', values: ['fixed', 'percentage', 'per_unit', 'fixed_plus_percentage', 'tiered', 'fx_buy_sell', 'manual_quote'], required: true },
    fee_currency: { type: 'string', description: 'Optional fee currency code.', required: false },
    input_currency: { type: 'string', description: 'Optional required input currency code.', required: false },
    minimum_fee: { type: 'string', description: 'Optional non-negative minimum fee.', required: false },
    maximum_fee: { type: 'string', description: 'Optional non-negative maximum fee.', required: false },
    rounding_mode: { type: 'enum', description: 'Optional rounding mode.', values: ['proportional', 'ceil_started_unit', 'floor_complete_unit', 'nearest_unit'], required: false },
    formula_config: { type: 'object', description: 'Pricing-engine formula configuration.', required: true },
  },
  returnSchema: '{ service, proposed_pricing_rule, change_request }',
  grantPermissions: ['propose'], category: 'pricing', risk: 'high',
}

// Transitional registry for domains not yet migrated to native PlatformToolManifest ownership.
const REGISTRY: ReadonlyArray<ToolDefinition> = [
  SERVICES_SEARCH,
  SERVICES_GET,
  PRICING_CALCULATE_QUOTE,
  CHANGE_REQUESTS_LIST_PENDING,
  SERVICES_PROPOSE_UPDATE,
  PRICING_RULES_PROPOSE_SERVICE_PRICE,
  SERVICES_MATCH_REQUEST,
]

export function listRegisteredTools(): ReadonlyArray<ToolDefinition> {
  return REGISTRY
}

export function getRegisteredTool(key: string): ToolDefinition | null {
  return REGISTRY.find((t) => t.key === key) ?? null
}

export function isGrantAllowed(tool: ToolDefinition, permission: ToolGrantPermission): boolean {
  return tool.grantPermissions.includes(permission)
}

export function renderToolCatalog(
  grants: ReadonlyArray<{ tool_key: string; permission: ToolGrantPermission }>,
): string {
  const lines: string[] = []
  for (const g of grants) {
    const tool = getRegisteredTool(g.tool_key)
    if (!tool) continue
    const args = Object.entries(tool.argumentSchema).map(
      ([name, s]) => `${name}${s.required === false ? '?' : ''}: ${s.type === 'enum' ? (s.values ?? ['string']).join('|') : s.type}`,
    )
    lines.push(
      `- ${tool.key} (${g.permission}): ${tool.description}` +
        (args.length > 0 ? ` | args: {${args.join(', ')}}` : ''),
    )
  }
  return lines.join('\n')
}
