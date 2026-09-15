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
  category: 'services' | 'pricing' | 'rates' | 'coverage' | 'intents' | 'changes'
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
    'Direction-aware coverage matching. Give the CUSTOMER pay and receive legs. Domestic rule: PAY south + RECEIVE north is an OFFER (commission returned to customer); PAY north + RECEIVE south is a REQUEST (customer pays commission). For a canonical request this searches the anti-parallel active offers and returns customer-safe availability plus commission options without provider identity/cost.',
  argumentSchema: {
    service_id: {
      type: 'string',
      description: 'Service UUID to match.',
      required: true,
    },
    currency: {
      type: 'string',
      description: 'Configured currency code, e.g. SAR.',
      required: true,
    },
    min_available: {
      type: 'string',
      description: 'Customer amount / minimum required available amount as a decimal string.',
      required: false,
    },
    pay_region_id: {
      type: 'string',
      description: 'Resolved coverage region UUID where the CUSTOMER pays.',
      required: false,
    },
    pay_region: {
      type: 'string',
      description: 'Human region name/code where the CUSTOMER pays, e.g. حضرموت or hadramawt.',
      required: false,
    },
    pay_macro: {
      type: 'enum',
      description: 'Customer pay macro region.',
      values: ['north', 'south', 'international'],
      required: false,
    },
    pay_method: {
      type: 'enum',
      description: 'Customer pay method.',
      values: ['cash', 'networks', 'remittance', 'bank_deposit', 'any'],
      required: false,
    },
    receive_region_id: {
      type: 'string',
      description: 'Resolved coverage region UUID where the CUSTOMER receives.',
      required: false,
    },
    receive_region: {
      type: 'string',
      description: 'Human region name/code where the CUSTOMER wants to receive, e.g. صنعاء or sanaa.',
      required: false,
    },
    receive_macro: {
      type: 'enum',
      description: 'Customer receive macro region.',
      values: ['north', 'south', 'international'],
      required: false,
    },
    receive_method: {
      type: 'enum',
      description: 'Customer receive method.',
      values: ['cash', 'networks', 'remittance', 'bank_deposit', 'any'],
      required: false,
    },
    limit: {
      type: 'number',
      description: 'Max matched offer rows before aggregation. Default 10, max 50.',
      required: false,
    },
  },
  returnSchema:
    '{ case_type, available, total_available, currency, matching_offer_count, resolved_legs, direction, commission_options: [{ rate_per_1000, commission_currency, total_available, offer_count, commission_amount_for_requested_amount }] } for customer plane; admin plane may receive anonymous offer rows with no provider cost/identity.',
  grantPermissions: ['read'],
  category: 'coverage',
  risk: 'read',
}

const COVERAGE_GET_RATES: ToolDefinition = {
  key: 'coverage.get_rates',
  version: 1,
  description:
    'Resolve and quote coverage commission from the CURRENT published board. For a concrete customer query pass amount/currency plus CUSTOMER pay and receive regions/methods. Domestic canonical rule is fixed: PAY south + RECEIVE north => offer / commission returned to customer (راجع للعميل); PAY north + RECEIVE south => request / customer pays commission (عمولة). The words راجع/عمولة do not define separate services. Quote ONLY values returned by this tool; if unpublished, never invent.',
  argumentSchema: {
    scope: {
      type: 'enum',
      description: "Board-only lookup market: 'north' | 'south' | 'international' | 'all'. For a concrete directional quote, omit or leave all.",
      values: ['north', 'south', 'international', 'all'],
      required: false,
    },
    amount: {
      type: 'string',
      description: 'Customer amount as a positive decimal string; when supplied the tool calculates total commission.',
      required: false,
    },
    currency: {
      type: 'string',
      description: 'Currency of amount/commission, e.g. SAR. Required when amount is supplied.',
      required: false,
    },
    pay_region_id: {
      type: 'string',
      description: 'Resolved coverage region UUID where the CUSTOMER pays.',
      required: false,
    },
    pay_region: {
      type: 'string',
      description: 'Human region name/code where the CUSTOMER pays, e.g. حضرموت or hadramawt.',
      required: false,
    },
    pay_macro: {
      type: 'enum',
      description: 'Customer pay macro region.',
      values: ['north', 'south', 'international'],
      required: false,
    },
    pay_method: {
      type: 'enum',
      description: 'Customer pay method.',
      values: ['cash', 'networks', 'remittance', 'bank_deposit', 'any'],
      required: false,
    },
    receive_region_id: {
      type: 'string',
      description: 'Resolved coverage region UUID where the CUSTOMER receives.',
      required: false,
    },
    receive_region: {
      type: 'string',
      description: 'Human region name/code where the CUSTOMER wants the money, e.g. صنعاء or sanaa.',
      required: false,
    },
    receive_macro: {
      type: 'enum',
      description: 'Customer receive macro region.',
      values: ['north', 'south', 'international'],
      required: false,
    },
    receive_method: {
      type: 'enum',
      description: 'Customer receive method.',
      values: ['cash', 'networks', 'remittance', 'bank_deposit', 'any'],
      required: false,
    },
  },
  returnSchema:
    '{ published, markets, resolved_legs?, direction?: { case_type, commission_effect, customer_term_ar, rate_market }, quote?: { status, amount, currency, rate_per_1000, commission_amount, commission_currency, effect, customer_term_ar }, domestic_direction_rules }',
  grantPermissions: ['read'],
  category: 'coverage',
  risk: 'read',
}

const COVERAGE_PROPOSE_OFFER: ToolDefinition = {
  key: 'coverage.propose_offer',
  version: 2,
  description:
    'Forward a confirmed domestic coverage case for approval. Canonical OFFER means CUSTOMER pays in SOUTH and receives in NORTH; commission is returned to the customer (راجع للعميل). The server re-resolves direction and snapshots the CURRENT published rate. If this tool is called for the opposite direction, the server auto-corrects to a request instead of persisting the wrong type.',
  argumentSchema: {
    service_id: {
      type: 'string',
      description: 'Service UUID.',
      required: true,
    },
    total_amount: {
      type: 'string',
      description: 'Customer coverage amount (decimal string).',
      required: true,
    },
    currency: {
      type: 'string',
      description: 'Configured currency code.',
      required: true,
    },
    attributes: {
      type: 'object',
      description:
        'Coverage legs. For domestic coverage include resolved pay_region_id + receive_region_id and pay_method + receive_method. These are CUSTOMER legs and must never be swapped.',
      required: false,
    },
    commission_per_thousand: {
      type: 'string',
      description: 'Optional legacy/model hint only; NOT authoritative for domestic coverage. Server snapshots the published board rate.',
      required: false,
    },
    commission_currency: {
      type: 'string',
      description: 'Optional legacy hint paired with commission_per_thousand; server uses the authoritative quote for domestic coverage.',
      required: false,
    },
    deal_date: {
      type: 'string',
      description: 'Business date (YYYY-MM-DD). Defaults to today.',
      required: false,
    },
  },
  returnSchema:
    '{ intent, change_request, coverage_case: { canonical_type, invoked_tool_type, auto_corrected, direction_code, commission_effect, customer_term_ar, resolved_legs }, commission_snapshot: { rate_per_1000, commission_amount, currency, source } }',
  grantPermissions: ['propose'],
  category: 'coverage',
  risk: 'medium',
}

const COVERAGE_PROPOSE_REQUEST: ToolDefinition = {
  key: 'coverage.propose_request',
  version: 1,
  description:
    'Forward a confirmed domestic coverage case for approval. Canonical REQUEST means CUSTOMER pays in NORTH and receives in SOUTH; the customer pays the commission (عمولة). The server re-resolves direction and snapshots the CURRENT published rate. If this tool is called for the opposite direction, the server auto-corrects to an offer instead of persisting the wrong type.',
  argumentSchema: {
    service_id: { type: 'string', description: 'Service UUID.', required: true },
    requested_amount: { type: 'string', description: 'Customer coverage amount as a decimal string.', required: true },
    currency: { type: 'string', description: 'Configured currency code.', required: true },
    attributes: {
      type: 'object',
      description: 'Coverage legs. For domestic coverage include resolved pay_region_id + receive_region_id and methods. These are CUSTOMER legs and must never be swapped.',
      required: false,
    },
    commission_per_thousand: { type: 'string', description: 'Optional legacy/model hint only; NOT authoritative for domestic coverage.', required: false },
    commission_currency: { type: 'string', description: 'Optional legacy hint; server uses the authoritative quote for domestic coverage.', required: false },
    deal_date: { type: 'string', description: 'Optional YYYY-MM-DD business date.', required: false },
    expires_at: { type: 'string', description: 'Optional ISO timestamp after which the request is no longer useful.', required: false },
  },
  returnSchema: '{ intent, change_request, coverage_case, commission_snapshot }',
  grantPermissions: ['propose'],
  category: 'coverage',
  risk: 'medium',
}

const COVERAGE_ADMIN_LIST_OFFERS: ToolDefinition = {
  key: 'coverage.admin_list_offers',
  version: 1,
  description: 'Admin-only operational view of coverage offers, including provider identity and internal cost fields.',
  argumentSchema: {
    status: { type: 'string', description: 'Optional exact lifecycle status.', required: false },
    limit: { type: 'number', description: 'Default 20, max 100.', required: false },
  },
  returnSchema: 'Array<admin coverage offer rows>',
  grantPermissions: ['read'], category: 'coverage', risk: 'read',
}

const COVERAGE_ADMIN_LIST_REQUESTS: ToolDefinition = {
  key: 'coverage.admin_list_requests',
  version: 1,
  description: 'Admin-only operational view of customer coverage requests.',
  argumentSchema: {
    status: { type: 'string', description: 'Optional exact lifecycle status.', required: false },
    limit: { type: 'number', description: 'Default 20, max 100.', required: false },
  },
  returnSchema: 'Array<admin coverage request rows>',
  grantPermissions: ['read'], category: 'coverage', risk: 'read',
}

const CHANGE_REQUESTS_LIST_PENDING: ToolDefinition = {
  key: 'change_requests.list_pending',
  version: 1,
  description: 'Admin-only list of pending proposed system changes awaiting a human decision.',
  argumentSchema: {
    limit: { type: 'number', description: 'Default 20, max 100.', required: false },
  },
  returnSchema: 'Array<{ id, code, target_type, intent, summary, proposed_payload, created_at, expires_at }>',
  grantPermissions: ['read'], category: 'changes', risk: 'read',
}

const INTENTS_PROPOSE_DECISION: ToolDefinition = {
  key: 'intents.propose_decision',
  version: 1,
  description: 'Admin-only proposal for resolving a generic customer intent after review.',
  argumentSchema: {
    intent_id: { type: 'string', description: 'Customer intent UUID.', required: true },
    decision: { type: 'enum', description: 'Resolution.', values: ['fulfilled', 'rejected', 'matched', 'clarifying'], required: true },
    matched_service_id: { type: 'string', description: 'Required when decision=matched.', required: false },
    reason: { type: 'string', description: 'Optional admin-facing rationale.', required: false },
  },
  returnSchema: '{ change_request: { id, code, confirmation_code, status } }',
  grantPermissions: ['propose'], category: 'intents', risk: 'medium',
}

const EXCHANGE_RATES_RECORD_TRADE_REQUEST: ToolDefinition = {
  key: 'exchange_rates.record_trade_request',
  version: 1,
  description:
    "Record this conversation's customer's request to buy or sell the base currency at the current published rate context. This NEVER changes exchange rates; it forwards the request to administration as a bound customer intent.",
  argumentSchema: {
    base_currency: { type: 'string', description: 'Currency being bought or sold.', required: true },
    quote_currency: { type: 'string', description: 'Settlement/quote currency.', required: true },
    intent: {
      type: 'enum',
      description: 'Customer side of the trade.',
      values: ['customer_sells_base', 'customer_buys_base'],
      required: true,
    },
    base_amount: { type: 'string', description: 'Positive amount of base currency the customer wants to buy/sell.', required: true },
    region: { type: 'string', description: 'Optional rate-book region context.', required: false },
    settlement: {
      type: 'enum',
      description: 'Optional settlement method.',
      values: ['cash', 'bank', 'wallet', 'other'],
      required: false,
    },
  },
  returnSchema: '{ intent, rate_snapshot }',
  grantPermissions: ['propose'],
  category: 'rates',
  risk: 'medium',
}

const EXCHANGE_RATES_ADMIN_LIST_BOOKS: ToolDefinition = {
  key: 'exchange_rates.admin_list_books',
  version: 1,
  description: 'Admin-only list of exchange-rate books and their current published version ids.',
  argumentSchema: {
    status: { type: 'string', description: 'Optional active/archived status.', required: false },
    limit: { type: 'number', description: 'Default 20, max 100.', required: false },
  },
  returnSchema: 'Array<{ id, name, region, current_published_version_id, status }>',
  grantPermissions: ['read'], category: 'rates', risk: 'read',
}

const EXCHANGE_RATES_PROPOSE_PAIR_CHANGE: ToolDefinition = {
  key: 'exchange_rates.propose_pair_change',
  version: 1,
  description: 'Admin-only proposal to replace one currency pair in a versioned rate book. Approval creates and atomically publishes a new version.',
  argumentSchema: {
    book_id: { type: 'string', description: 'Exchange-rate book UUID.', required: true },
    base_currency: { type: 'string', description: 'Base currency code.', required: true },
    quote_currency: { type: 'string', description: 'Quote currency code.', required: true },
    buy_rate: { type: 'string', description: 'Positive decimal buy rate.', required: true },
    sell_rate: { type: 'string', description: 'Positive decimal sell rate.', required: true },
    rate_unit: { type: 'string', description: 'Optional positive rate unit.', required: false },
    notes_public: { type: 'string', description: 'Optional public rate note.', required: false },
  },
  returnSchema: '{ rate_book, proposed_rate, change_request }',
  grantPermissions: ['propose'], category: 'rates', risk: 'high',
}

const SERVICES_PROPOSE_UPDATE: ToolDefinition = {
  key: 'services.propose_update',
  version: 1,
  description: 'Admin-only proposal to publish a new service revision. Internal-only fields are preserved but never exposed to or editable by the model.',
  argumentSchema: {
    service_id: { type: 'string', description: 'Service UUID.', required: true },
    name: { type: 'string', description: 'Optional new service name.', required: false },
    public_description: { type: 'string', description: 'Optional new public description.', required: false },
    ai_guidance: { type: 'string', description: 'Optional AI guidance. Never customer-visible.', required: false },
    field_values_patch: { type: 'object', description: 'Patch to non-internal schema fields only.', required: false },
    pricing_rule_id: { type: 'string', description: 'Optional published pricing-rule UUID.', required: false },
    status: { type: 'enum', description: 'Optional service lifecycle state.', values: ['draft','active','paused','archived'], required: false },
  },
  returnSchema: '{ service, proposed, change_request }',
  grantPermissions: ['propose'], category: 'services', risk: 'high',
}

const PRICING_RULES_PROPOSE_SERVICE_PRICE: ToolDefinition = {
  key: 'pricing_rules.propose_service_price',
  version: 1,
  description:
    'Admin-only proposal to create a new immutable pricing rule and attach it through a new service revision after approval.',
  argumentSchema: {
    service_id: { type: 'string', description: 'Service UUID.', required: true },
    name: { type: 'string', description: 'Pricing rule name.', required: true },
    kind: {
      type: 'enum',
      description: 'Pricing formula kind.',
      values: ['fixed','percentage','per_unit','fixed_plus_percentage','tiered','fx_buy_sell','manual_quote'],
      required: true,
    },
    fee_currency: { type: 'string', description: 'Optional fee currency code.', required: false },
    input_currency: { type: 'string', description: 'Optional required input currency code.', required: false },
    minimum_fee: { type: 'string', description: 'Optional non-negative minimum fee.', required: false },
    maximum_fee: { type: 'string', description: 'Optional non-negative maximum fee.', required: false },
    rounding_mode: {
      type: 'enum',
      description: 'Optional rounding mode.',
      values: ['proportional','ceil_started_unit','floor_complete_unit','nearest_unit'],
      required: false,
    },
    formula_config: { type: 'object', description: 'Pricing-engine formula configuration.', required: true },
  },
  returnSchema: '{ service, proposed_pricing_rule, change_request }',
  grantPermissions: ['propose'],
  category: 'pricing',
  risk: 'high',
}

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
  COVERAGE_PROPOSE_REQUEST,
  COVERAGE_ADMIN_LIST_OFFERS,
  COVERAGE_ADMIN_LIST_REQUESTS,
  CHANGE_REQUESTS_LIST_PENDING,
  INTENTS_PROPOSE_DECISION,
  EXCHANGE_RATES_RECORD_TRADE_REQUEST,
  EXCHANGE_RATES_ADMIN_LIST_BOOKS,
  EXCHANGE_RATES_PROPOSE_PAIR_CHANGE,
  SERVICES_PROPOSE_UPDATE,
  PRICING_RULES_PROPOSE_SERVICE_PRICE,
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
