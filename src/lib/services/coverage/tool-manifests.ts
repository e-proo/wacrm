import {
  assertValidToolManifest,
  type PlatformToolManifest,
} from '@/lib/ai/tools/platform/contracts'
import { STANDARD_PLATFORM_TOOL_ERRORS } from '@/lib/services/platform/tool-contract-defaults'

function defineCoverageTool(tool: PlatformToolManifest): PlatformToolManifest {
  return assertValidToolManifest(tool)
}

export const COVERAGE_TOOL_MANIFESTS: readonly PlatformToolManifest[] = [
  defineCoverageTool({
    key: 'coverage.check_availability',
    version: 1,
    domain: 'coverage',
    title: 'Check coverage availability',
    description:
      'Check whether the account has active coverage availability for a service. Returns aggregated totals.',
    purpose: 'Read aggregate coverage headroom without exposing provider internals.',
    whenToUse: [
      'The service/currency/required amount are known and availability needs checking.',
    ],
    whenNotToUse: ['Do not reveal provider identity/internal cost to customer plane.'],
    inputSchema: {
      service_id: { type: 'string', description: 'Service UUID.', required: true },
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
    outputSchema: {
      description:
        '{ available: boolean, total_amount, reserved_amount, fulfilled_amount, currency, offer_count }',
    },
    permission: 'read',
    risk: 'read',
    allowedPlanes: ['customer', 'admin'],
    requiredCapabilities: ['coverage.read'],
    supportedGrantConstraints: ['service_ids', 'currencies'],
    sideEffect: 'none',
    approvalRequired: false,
    idempotent: true,
    audit: 'invocation',
    modelExposed: true,
    serverOnly: false,
    examples: [],
    errorContract: STANDARD_PLATFORM_TOOL_ERRORS,
  }),
  defineCoverageTool({
    key: 'coverage.find_offers',
    version: 2,
    domain: 'coverage',
    title: 'Find coverage offers',
    description:
      'Direction-aware coverage matching. Give the CUSTOMER pay and receive legs. Domestic rule: PAY south + RECEIVE north is an OFFER (commission returned to customer); PAY north + RECEIVE south is a REQUEST (customer pays commission). For a canonical request this searches the anti-parallel active offers and returns customer-safe availability plus commission options without provider identity/cost.',
    purpose:
      'Search canonical coverage supply using the CUSTOMER pay and receive legs. PAY is where/how the customer hands money to the business; RECEIVE is where/how the customer gets the covered amount.',
    whenToUse: [
      'Use when both customer legs are understood. A north-pay to south-receive request matches anti-parallel south-pay to north-receive offers. If wording conflicts, clarify before searching.',
    ],
    whenNotToUse: [
      'Never swap the legs because of word order. Never expose provider identity/internal cost on customer plane.',
    ],
    inputSchema: {
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
        description:
          'Customer amount / minimum required available amount as a decimal string.',
        required: false,
      },
      pay_region_id: {
        type: 'string',
        description: 'Resolved coverage region UUID where the CUSTOMER pays.',
        required: false,
      },
      pay_region: {
        type: 'string',
        description: 'Human region name/code where the CUSTOMER pays.',
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
        description: 'Human region name/code where the CUSTOMER wants to receive.',
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
    outputSchema: {
      description:
        '{ case_type, available, total_available, currency, matching_offer_count, resolved_legs, direction, commission_options }',
    },
    permission: 'read',
    risk: 'read',
    allowedPlanes: ['customer', 'admin'],
    requiredCapabilities: ['coverage.read'],
    supportedGrantConstraints: ['service_ids', 'currencies'],
    sideEffect: 'none',
    approvalRequired: false,
    idempotent: true,
    audit: 'invocation',
    modelExposed: true,
    serverOnly: false,
    examples: [],
    errorContract: STANDARD_PLATFORM_TOOL_ERRORS,
  }),
  defineCoverageTool({
    key: 'coverage.get_rates',
    version: 1,
    domain: 'coverage',
    title: 'Resolve coverage direction and quote commission',
    description:
      'Resolve and quote coverage commission from the CURRENT published board. For a concrete customer query pass amount/currency plus CUSTOMER pay and receive regions/methods. Domestic canonical rule is fixed: PAY south + RECEIVE north => offer / commission returned to customer (راجع للعميل); PAY north + RECEIVE south => request / customer pays commission (عمولة). The words راجع/عمولة do not define separate services. Quote ONLY values returned by this tool; if unpublished, never invent.',
    purpose:
      'Resolve customer pay/receive regions, classify the canonical north/south coverage direction, read the published rate, and calculate commission.',
    whenToUse: [
      'Use first for a concrete coverage question. South-pay to north-receive is an offer with commission returned; north-pay to south-receive is a request with commission paid by customer.',
    ],
    whenNotToUse: [
      'Never swap pay/receive from word order or from the words راجع/عمولة. Do not invent a missing unpublished rate.',
    ],
    inputSchema: {
      scope: {
        type: 'enum',
        description: "Board-only lookup market: 'north' | 'south' | 'international' | 'all'.",
        values: ['north', 'south', 'international', 'all'],
        required: false,
      },
      amount: {
        type: 'string',
        description: 'Customer amount as a positive decimal string.',
        required: false,
      },
      currency: {
        type: 'string',
        description: 'Currency of amount/commission, e.g. SAR.',
        required: false,
      },
      pay_region_id: {
        type: 'string',
        description: 'Resolved coverage region UUID where the CUSTOMER pays.',
        required: false,
      },
      pay_region: {
        type: 'string',
        description: 'Human region name/code where the CUSTOMER pays.',
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
        description: 'Human region name/code where the CUSTOMER wants the money.',
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
    outputSchema: {
      description:
        '{ published, markets, resolved_legs?, direction?, quote?, domestic_direction_rules }',
    },
    permission: 'read',
    risk: 'read',
    allowedPlanes: ['customer', 'admin'],
    requiredCapabilities: ['coverage.read'],
    supportedGrantConstraints: ['channels'],
    sideEffect: 'none',
    approvalRequired: false,
    idempotent: true,
    audit: 'invocation',
    modelExposed: true,
    serverOnly: false,
    examples: [],
    errorContract: STANDARD_PLATFORM_TOOL_ERRORS,
  }),
  defineCoverageTool({
    key: 'coverage.propose_offer',
    version: 2,
    domain: 'coverage',
    title: 'Forward canonical coverage offer',
    description:
      'Forward a confirmed domestic coverage case for approval. Canonical OFFER means CUSTOMER pays in SOUTH and receives in NORTH; commission is returned to the customer (راجع للعميل). The server re-resolves direction and snapshots the CURRENT published rate. If this tool is called for the opposite direction, the server auto-corrects to a request instead of persisting the wrong type.',
    purpose:
      'Create a typed approval proposal for the canonical domestic south-pay to north-receive coverage direction.',
    whenToUse: [
      'The customer pays in the south and receives in the north and has confirmed the offer.',
    ],
    whenNotToUse: [
      'Never swap customer pay/receive legs or trust a model-supplied commission over the published board.',
    ],
    inputSchema: {
      service_id: { type: 'string', description: 'Service UUID.', required: true },
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
          'Coverage legs. Include resolved customer pay/receive legs when known.',
        required: false,
      },
      commission_per_thousand: {
        type: 'string',
        description: 'Optional legacy/model hint only; NOT authoritative.',
        required: false,
      },
      commission_currency: {
        type: 'string',
        description: 'Optional legacy hint.',
        required: false,
      },
      deal_date: {
        type: 'string',
        description: 'Business date (YYYY-MM-DD). Defaults to today.',
        required: false,
      },
    },
    outputSchema: {
      description: '{ intent, change_request, coverage_case, commission_snapshot }',
    },
    permission: 'propose',
    risk: 'medium',
    allowedPlanes: ['customer'],
    requiredCapabilities: ['coverage.propose'],
    supportedGrantConstraints: ['service_ids', 'currencies'],
    sideEffect: 'proposal',
    approvalRequired: false,
    idempotent: true,
    audit: 'proposal_and_execution',
    modelExposed: true,
    serverOnly: false,
    examples: [],
    errorContract: STANDARD_PLATFORM_TOOL_ERRORS,
  }),
  defineCoverageTool({
    key: 'coverage.propose_request',
    version: 1,
    domain: 'coverage',
    title: 'Forward canonical coverage request',
    description:
      'Forward a confirmed domestic coverage case for approval. Canonical REQUEST means CUSTOMER pays in NORTH and receives in SOUTH; the customer pays the commission (عمولة). The server re-resolves direction and snapshots the CURRENT published rate. If this tool is called for the opposite direction, the server auto-corrects to an offer instead of persisting the wrong type.',
    purpose:
      'Create a typed approval proposal for the canonical domestic north-pay to south-receive coverage direction.',
    whenToUse: [
      'The customer pays in the north and receives in the south and has confirmed the request.',
    ],
    whenNotToUse: [
      'Never swap customer pay/receive legs or trust a model-supplied commission over the published board.',
    ],
    inputSchema: {
      service_id: { type: 'string', description: 'Service UUID.', required: true },
      requested_amount: {
        type: 'string',
        description: 'Customer coverage amount as a decimal string.',
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
          'Coverage legs. Include resolved customer pay/receive legs when known.',
        required: false,
      },
      commission_per_thousand: {
        type: 'string',
        description: 'Optional legacy/model hint only; NOT authoritative.',
        required: false,
      },
      commission_currency: {
        type: 'string',
        description: 'Optional legacy hint.',
        required: false,
      },
      deal_date: {
        type: 'string',
        description: 'Optional YYYY-MM-DD business date.',
        required: false,
      },
      expires_at: {
        type: 'string',
        description: 'Optional ISO timestamp.',
        required: false,
      },
    },
    outputSchema: {
      description: '{ intent, change_request, coverage_case, commission_snapshot }',
    },
    permission: 'propose',
    risk: 'medium',
    allowedPlanes: ['customer'],
    requiredCapabilities: ['coverage.propose'],
    supportedGrantConstraints: ['service_ids', 'currencies'],
    sideEffect: 'proposal',
    approvalRequired: false,
    idempotent: true,
    audit: 'proposal_and_execution',
    modelExposed: true,
    serverOnly: false,
    examples: [],
    errorContract: STANDARD_PLATFORM_TOOL_ERRORS,
  }),
  defineCoverageTool({
    key: 'coverage.admin_list_offers',
    version: 1,
    domain: 'coverage',
    title: 'List coverage offers for admin',
    description:
      'Admin-only operational view of coverage offers, including provider identity and internal cost fields.',
    purpose: 'Give trusted administration the operational offer view.',
    whenToUse: [
      'Administration asks for available offers, providers, or operational offer status.',
    ],
    whenNotToUse: ['Never expose this internal DTO on the customer plane.'],
    inputSchema: {
      status: {
        type: 'string',
        description: 'Optional exact lifecycle status.',
        required: false,
      },
      limit: {
        type: 'number',
        description: 'Default 20, max 100.',
        required: false,
      },
    },
    outputSchema: { description: 'Array<admin coverage offer rows>' },
    permission: 'read',
    risk: 'read',
    allowedPlanes: ['admin'],
    requiredCapabilities: ['coverage.read'],
    supportedGrantConstraints: ['channels'],
    sideEffect: 'none',
    approvalRequired: false,
    idempotent: true,
    audit: 'invocation',
    modelExposed: true,
    serverOnly: false,
    examples: [],
    errorContract: STANDARD_PLATFORM_TOOL_ERRORS,
  }),
  defineCoverageTool({
    key: 'coverage.admin_list_requests',
    version: 1,
    domain: 'coverage',
    title: 'List coverage requests for admin',
    description:
      'Admin-only operational view of customer coverage requests.',
    purpose: 'Give trusted administration the operational request view.',
    whenToUse: [
      'Administration asks for incoming or current coverage requests.',
    ],
    whenNotToUse: ['Never expose this internal DTO on the customer plane.'],
    inputSchema: {
      status: {
        type: 'string',
        description: 'Optional exact lifecycle status.',
        required: false,
      },
      limit: {
        type: 'number',
        description: 'Default 20, max 100.',
        required: false,
      },
    },
    outputSchema: { description: 'Array<admin coverage request rows>' },
    permission: 'read',
    risk: 'read',
    allowedPlanes: ['admin'],
    requiredCapabilities: ['coverage.read'],
    supportedGrantConstraints: ['channels'],
    sideEffect: 'none',
    approvalRequired: false,
    idempotent: true,
    audit: 'invocation',
    modelExposed: true,
    serverOnly: false,
    examples: [],
    errorContract: STANDARD_PLATFORM_TOOL_ERRORS,
  }),
]
