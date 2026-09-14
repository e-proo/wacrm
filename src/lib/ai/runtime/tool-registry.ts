// ============================================================
// Tool registry — Phase 3 (live tools).
//
// Phase 1 shipped an empty registry. Phase 3 activates the
// read-only tools that the agents can call to answer questions
// about the live services catalog, pricing rules, exchange rates,
// and coverage availability.
//
// The registry is the SINGLE source of truth for:
//   • the (key, version) tuple the runtime validates against,
//   • the schema the model uses to emit arguments,
//   • the permission level the runtime checks (read vs propose
//     vs execute — see plan §4.3).
//
// Adding a tool:
//   1. Define it here with `effect: 'read'` (or 'propose' if it
//      must go through the change-request approval flow),
//   2. Wire its executor in src/lib/ai/tools/executors.ts,
//   3. Add a test in src/lib/ai/runtime/tool-registry.test.ts.
//
// Removing a tool means bumping the version of any agent that
// referenced it (the version check in agents-service.ts refuses
// to publish with stale tool grants).
// ============================================================

import type { ToolGrantPermission } from './multi-agent-types'

export type ToolEffect = 'read' | 'propose' | 'execute-internal'

export interface ToolDefinition {
  key: string
  version: number
  description: string
  /** Brief usage shown to the agent (e.g. "returns up to N rows"). */
  notes?: string
  /** Human-readable argument shape the model is expected to emit. */
  argumentSchema: Record<string, ArgumentSchema>
  /** Human-readable return shape the model can cite. */
  returnSchema: string
  /** Closed permission levels this tool can be granted at. */
  grantPermissions: ReadonlyArray<ToolGrantPermission>
  /** The runtime category of this tool — used to group docs. */
  category: 'services' | 'pricing' | 'rates' | 'coverage' | 'intents'
  risk: 'read' | 'low' | 'medium' | 'high'
}

export interface ArgumentSchema {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'object'
  description: string
  /** Optional enum values when type === 'enum'. */
  values?: string[]
  required?: boolean
}

// ------------------------------------------------------------
// The registry itself
// ------------------------------------------------------------

const SERVICES_SEARCH: ToolDefinition = {
  key: 'services.search',
  version: 1,
  description:
    'Search the active services catalog. Returns name + public description + code.',
  argumentSchema: {
    query: {
      type: 'string',
      description: 'Free-text query; matches against name and code.',
      required: false,
    },
    category_id: {
      type: 'string',
      description: 'Restrict to a specific category UUID.',
      required: false,
    },
    limit: {
      type: 'number',
      description: 'Max results. Default 10, max 50.',
      required: false,
    },
  },
  returnSchema: 'Array<{ id, name, code, category_id, public_description }>',
  grantPermissions: ['read'],
  category: 'services',
  risk: 'read',
}

const SERVICES_GET: ToolDefinition = {
  key: 'services.get',
  version: 1,
  description:
    'Read a single service by id or code. Returns public fields only.',
  argumentSchema: {
    id_or_code: {
      type: 'string',
      description: 'Service UUID or internal code (e.g. COV-SANA-CASH).',
      required: true,
    },
  },
  returnSchema:
    '{ id, name, code, status, public_description, field_values, pricing_quote }',
  grantPermissions: ['read'],
  category: 'services',
  risk: 'read',
}

const PRICING_CALCULATE_QUOTE: ToolDefinition = {
  key: 'pricing.calculate_quote',
  version: 1,
  description:
    'Compute a fee for a service + amount. Returns fee amount + currency + rendered facts. Does NOT mutate state.',
  argumentSchema: {
    service_id: {
      type: 'string',
      description: 'Service UUID.',
      required: true,
    },
    amount: {
      type: 'string',
      description: 'Amount as a decimal string (e.g. "10000.00").',
      required: true,
    },
    currency: {
      type: 'string',
      description: 'ISO-4217-like 3-letter code.',
      required: true,
    },
    attributes: {
      type: 'object',
      description: 'Service-specific attributes (e.g. coverage_region).',
      required: false,
    },
  },
  returnSchema:
    'QuoteResult { status, feeAmount, feeCurrency, renderedFacts, inputAmount, inputCurrency, precision, audit }',
  grantPermissions: ['read'],
  category: 'pricing',
  risk: 'read',
}

const EXCHANGE_RATES_GET_CURRENT: ToolDefinition = {
  key: 'exchange_rates.get_current',
  version: 1,
  description:
    'Read the current live exchange rate for a currency pair in a context. Returns stale-aware status.',
  argumentSchema: {
    base_currency: {
      type: 'string',
      description: 'ISO-4217-like code (e.g. SAR).',
      required: true,
    },
    quote_currency: {
      type: 'string',
      description: 'ISO-4217-like code (e.g. YER).',
      required: true,
    },
    intent: {
      type: 'enum',
      description: "Customer's side of the trade.",
      values: ['customer_sells_base', 'customer_buys_base'],
      required: true,
    },
    region: {
      type: 'string',
      description: 'Region label (e.g. Sanaa) or null for wildcard.',
      required: false,
    },
    settlement: {
      type: 'enum',
      description: 'Settlement method or null for wildcard.',
      values: ['cash', 'bank', 'wallet', 'other'],
      required: false,
    },
  },
  returnSchema:
    "CurrentRateResult { status: 'current' | 'unavailable_stale' | 'not_found', rate, side, valid_until, meaning }",
  grantPermissions: ['read'],
  category: 'rates',
  risk: 'read',
}

const COVERAGE_CHECK_AVAILABILITY: ToolDefinition = {
  key: 'coverage.check_availability',
  version: 1,
  description:
    'Check whether the account has active coverage availability for a service. Returns aggregated totals.',
  argumentSchema: {
    service_id: {
      type: 'string',
      description: 'Service UUID.',
      required: true,
    },
    currency: {
      type: 'string',
      description: 'ISO-4217-like code.',
      required: true,
    },
    min_amount: {
      type: 'string',
      description: 'Required minimum amount (decimal string).',
      required: true,
    },
  },
  returnSchema:
    '{ available: boolean, total_amount, reserved_amount, fulfilled_amount, currency, offer_count }',
  grantPermissions: ['read'],
  category: 'coverage',
  risk: 'read',
}

const SERVICES_MATCH_REQUEST: ToolDefinition = {
  key: 'services.match_request',
  version: 1,
  description:
    'Match a customer request against equipped service schemas. Returns exact / partial / none with missing fields. NEVER prices or promises on "none" — escalate instead.',
  argumentSchema: {
    service_hint: {
      type: 'string',
      description: 'What the customer asked for, in a few words (e.g. "outward remittance").',
      required: false,
    },
    attributes: {
      type: 'object',
      description: 'What the agent understood from the customer, as key/value pairs.',
      required: true,
    },
    limit: {
      type: 'number',
      description: 'Max candidates. Default 10, max 50.',
      required: false,
    },
  },
  returnSchema:
    'MatchResult { match: exact|partial|none, candidates: [{ service_id, name, classification, missing_fields, unknown_fields }] }',
  grantPermissions: ['read'],
  category: 'services',
  risk: 'read',
}

const INTENTS_RECORD: ToolDefinition = {
  key: 'intents.record',
  version: 1,
  description:
    "Record a general observation about a customer's need or offer — even for services NOT equipped yet. Optionally escalates to the trusted admin for a decision.",
  argumentSchema: {
    contact_id: {
      type: 'string',
      description: 'Contact UUID of the customer.',
      required: true,
    },
    conversation_id: {
      type: 'string',
      description: 'Current conversation UUID.',
      required: false,
    },
    direction: {
      type: 'enum',
      description: 'Whether the customer provides or needs the service.',
      values: ['offer', 'request'],
      required: true,
    },
    service_hint: {
      type: 'string',
      description: 'Short label of the service (e.g. "outward remittance to KL").',
      required: true,
    },
    summary: {
      type: 'string',
      description: 'One-paragraph human summary for the admin.',
      required: false,
    },
    attributes: {
      type: 'object',
      description: 'Key/value details the agent understood (city, amount, currency...).',
      required: false,
    },
    escalate_to_admin: {
      type: 'boolean',
      description: 'True when the admin must decide before anything is promised.',
      required: false,
    },
  },
  returnSchema:
    '{ intent_id, status, change_request?: { id, code, confirmation_code } }',
  grantPermissions: ['propose'],
  category: 'intents',
  risk: 'low',
}

const INTENTS_SEARCH: ToolDefinition = {
  key: 'intents.search',
  version: 1,
  description:
    "Search the account's recorded customer intents (general memory) by contact, status, or free text.",
  argumentSchema: {
    contact_id: {
      type: 'string',
      description: 'Restrict to one contact.',
      required: false,
    },
    status: {
      type: 'enum',
      description: 'Filter by lifecycle status.',
      values: ['new', 'clarifying', 'forwarded_to_admin', 'fulfilled', 'rejected', 'matched'],
      required: false,
    },
    q: {
      type: 'string',
      description: 'Free text over service_hint and summary.',
      required: false,
    },
    limit: {
      type: 'number',
      description: 'Max results. Default 20, max 100.',
      required: false,
    },
  },
  returnSchema:
    'Array<{ intent_id, contact_id, direction, service_hint, summary, status, attributes, created_at }>',
  grantPermissions: ['read'],
  category: 'intents',
  risk: 'read',
}

const COVERAGE_FIND_OFFERS: ToolDefinition = {
  key: 'coverage.find_offers',
  version: 2,
  description:
    'Search ACTIVE coverage offers by service, currency, and minimum headroom, optionally filtered by receive region (exact id or macro north/south/international) and method. Returns aggregated rows WITHOUT provider identity or cost — the requester-facing DTO stays anonymous.',
  argumentSchema: {
    service_id: {
      type: 'string',
      description: 'Service UUID to match.',
      required: true,
    },
    currency: {
      type: 'string',
      description: 'ISO-4217-like code.',
      required: true,
    },
    min_available: {
      type: 'string',
      description: 'Minimum remaining headroom (decimal string).',
      required: false,
    },
    receive_region_id: {
      type: 'string',
      description: 'Exact coverage region UUID for the RECEIVE leg.',
      required: false,
    },
    receive_macro: {
      type: 'string',
      description: "Macro region filter: 'north' | 'south' | 'international'.",
      required: false,
    },
    receive_method: {
      type: 'string',
      description: "'cash' | 'networks' | 'bank_deposit' | 'any'.",
      required: false,
    },
    limit: {
      type: 'number',
      description: 'Max rows. Default 10, max 50.',
      required: false,
    },
  },
  returnSchema:
    'Array<{ offer_id, reference_code, available_amount, currency, commission_per_thousand, commission_currency, attributes (validated coverage legs) }> — NO provider_contact_id, NO provider_cost.',
  grantPermissions: ['read'],
  category: 'coverage',
  risk: 'read',
}

const COVERAGE_GET_RATES: ToolDefinition = {
  key: 'coverage.get_rates',
  version: 1,
  description:
    "Read the account's CURRENT published commission rate board (migration 062): rates per 1000 for cash pickup / remittance / coverage, grouped by market (north, south, international). Quote ONLY the published numbers, state they are per 1000 and can change; when a rate or the whole board is missing, do NOT invent a figure — say the desk confirms it per case.",
  argumentSchema: {
    scope: {
      type: 'enum',
      description: "Market to return: 'north' | 'south' | 'international' | 'all' (default).",
      required: false,
    },
  },
  returnSchema:
    '{ published: boolean, updated_at, scope rates { cash_per_1000, remittance_per_1000, coverage_per_1000 } } | { published: false }',
  grantPermissions: ['read'],
  category: 'coverage',
  risk: 'read',
}

const COVERAGE_PROPOSE_OFFER: ToolDefinition = {
  key: 'coverage.propose_offer',
  version: 1,
  description:
    "Propose creating a coverage offer from a customer's stated liquidity. Creates a change request for the trusted admin — the offer is NOT created until the admin approves with the confirmation code.",
  argumentSchema: {
    contact_id: {
      type: 'string',
      description: 'Customer contact UUID providing the liquidity.',
      required: true,
    },
    service_id: {
      type: 'string',
      description: 'Service UUID.',
      required: true,
    },
    total_amount: {
      type: 'string',
      description: 'Offered amount (decimal string).',
      required: true,
    },
    currency: {
      type: 'string',
      description: 'ISO-4217-like code.',
      required: true,
    },
    attributes: {
      type: 'object',
      description:
        'Coverage legs: coverage_scope (domestic|international), coverage_country, receive_region_id, receive_method, pay_region_id, pay_method (cash|networks|bank_deposit|any).',
      required: false,
    },
    commission_per_thousand: {
      type: 'string',
      description: 'Commission RATE per 1000 units (e.g. "7" = 7 per 1000). Optional.',
      required: false,
    },
    commission_currency: {
      type: 'string',
      description: 'Commission currency code; required when commission_per_thousand is set.',
      required: false,
    },
    deal_date: {
      type: 'string',
      description: 'Business date (YYYY-MM-DD). Defaults to today.',
      required: false,
    },
  },
  returnSchema:
    '{ intent?: { intent_id, status }, change_request: { id, code, confirmation_code } } — quote the code + confirmation to the admin over WhatsApp.',
  grantPermissions: ['propose'],
  category: 'coverage',
  risk: 'medium',
}

// ------------------------------------------------------------
// Phase 3 (later): propose_* tools
// ------------------------------------------------------------
// These will go through the change-request approval flow.
// Listed here as documentation; not registered until the
// approval engine ships.

// services.propose_rate_change         (propose)
// services.propose_offer_creation       (propose)
// pricing_rules.propose_update          (propose)
// exchange_rates.propose_publish         (propose)
// coverage.propose_match_reservation    (propose)

// ------------------------------------------------------------
// Registry
// ------------------------------------------------------------
const REGISTRY: ReadonlyArray<ToolDefinition> = [
  SERVICES_SEARCH,
  SERVICES_GET,
  PRICING_CALCULATE_QUOTE,
  EXCHANGE_RATES_GET_CURRENT,
  COVERAGE_CHECK_AVAILABILITY,
  COVERAGE_FIND_OFFERS,
  COVERAGE_GET_RATES,
  COVERAGE_PROPOSE_OFFER,
  SERVICES_MATCH_REQUEST,
  INTENTS_RECORD,
  INTENTS_SEARCH,
]

export function listRegisteredTools(): ReadonlyArray<ToolDefinition> {
  return REGISTRY
}

export function getRegisteredTool(key: string): ToolDefinition | null {
  return REGISTRY.find((t) => t.key === key) ?? null
}

export function isGrantAllowed(
  tool: ToolDefinition,
  permission: ToolGrantPermission,
): boolean {
  return tool.grantPermissions.includes(permission)
}

/**
 * Prompt-facing catalog of the tools a revision may call — the model
 * can only use what it is TOLD about. One compact line per granted
 * + registered tool; unknown/stale grant rows are skipped (they are
 * surfaced by the publish checklist instead). The caller layers the
 * ```tool fence protocol around it (see buildSystemPrompt).
 */
export function renderToolCatalog(
  grants: ReadonlyArray<{ tool_key: string; permission: ToolGrantPermission }>,
): string {
  const lines: string[] = []
  for (const g of grants) {
    const tool = getRegisteredTool(g.tool_key)
    if (!tool) continue
    const args = Object.entries(tool.argumentSchema).map(
      ([name, s]) =>
        `${name}${s.required === false ? '?' : ''}: ${
          s.type === 'enum' ? (s.values ?? ['string']).join('|') : s.type
        }`,
    )
    lines.push(
      `- ${tool.key} (${g.permission}): ${tool.description}` +
        (args.length > 0 ? ` | args: {${args.join(', ')}}` : ''),
    )
  }
  return lines.join('\n')
}
