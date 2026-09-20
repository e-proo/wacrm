import {
  assertValidToolManifest,
  type PlatformToolManifest,
} from '@/lib/ai/tools/platform/contracts'
import { STANDARD_PLATFORM_TOOL_ERRORS } from '@/lib/services/platform/tool-contract-defaults'

function defineFxTool(tool: PlatformToolManifest): PlatformToolManifest {
  return assertValidToolManifest(tool)
}

export const FX_V2_TOOL_MANIFESTS: readonly PlatformToolManifest[] = [
  defineFxTool({
    key: 'exchange_rates.get_current',
    version: 1,
    domain: 'exchange_rates',
    title: 'Read current FX V2 rate',
    description:
      'Read the authoritative CURRENT FX V2 rate for an explicit currency pair and customer buy/sell side. Current rate questions must use this tool; conversation history and knowledge text are not authoritative rate sources.',
    purpose:
      'Read the authoritative current FX V2 rate/version for an explicit pair and customer buy/sell side.',
    whenToUse: [
      'MUST be used whenever a customer or admin asks for a concrete/current exchange rate. The returned rate_version_id is the quote token for a later trade request.',
    ],
    whenNotToUse: [
      'Never answer a concrete current rate from conversation history or knowledge text. Never swap the customer buy/sell side and never use region/settlement to choose an FX V2 price.',
    ],
    inputSchema: {
      base_currency: {
        type: 'string',
        description: 'Configured base currency code (e.g. SAR).',
        required: true,
      },
      quote_currency: {
        type: 'string',
        description: 'Configured quote currency code (e.g. YER).',
        required: true,
      },
      intent: {
        type: 'enum',
        description: "Customer's side of the trade relative to the base currency.",
        values: ['customer_sells_base', 'customer_buys_base'],
        required: true,
      },
      region: {
        type: 'string',
        description: 'Legacy context only; FX V2 does not select prices by region.',
        required: false,
      },
      settlement: {
        type: 'enum',
        description: 'Legacy context only; FX V2 does not select prices by settlement method.',
        values: ['cash', 'bank', 'wallet', 'other'],
        required: false,
      },
    },
    outputSchema: {
      description:
        "{ status: 'current' | 'not_found', pair_id?, base_currency, quote_currency, customer_side?, effective_rate?, rate_version_id?, version_number?, published_at?, meaning? }",
    },
    permission: 'read',
    risk: 'read',
    allowedPlanes: ['customer', 'admin'],
    requiredCapabilities: ['rates.read'],
    supportedGrantConstraints: ['currencies'],
    sideEffect: 'none',
    approvalRequired: false,
    idempotent: true,
    audit: 'invocation',
    modelExposed: true,
    serverOnly: false,
    examples: [],
    errorContract: STANDARD_PLATFORM_TOOL_ERRORS,
  }),
  defineFxTool({
    key: 'exchange_rates.record_trade_request',
    version: 2,
    domain: 'exchange_rates',
    title: 'Create customer FX V2 trade request',
    description:
      "Create this conversation customer's real FX V2 trade request against the exact rate version already quoted by exchange_rates.get_current. This NEVER changes a rate and NEVER marks settlement complete; the new request starts pending_admin.",
    purpose:
      'Create the current customer’s real pending FX V2 trade request against the exact immutable rate version they were quoted.',
    whenToUse: [
      'Use only after exchange_rates.get_current returned the pair rate and the customer confirmed the amount/side. Pass that exact rate_version_id as expected_rate_version_id.',
    ],
    whenNotToUse: [
      'Never change an exchange rate, never invent/substitute a rate version, never use it without server-bound customer identity, and never describe pending_admin as completed settlement.',
    ],
    inputSchema: {
      base_currency: {
        type: 'string',
        description: 'Base currency being bought or sold.',
        required: true,
      },
      quote_currency: {
        type: 'string',
        description: 'Explicit quote currency.',
        required: true,
      },
      intent: {
        type: 'enum',
        description: 'Customer side of the trade relative to base currency.',
        values: ['customer_sells_base', 'customer_buys_base'],
        required: true,
      },
      base_amount: {
        type: 'string',
        description: 'Positive amount of base currency the customer confirmed.',
        required: true,
      },
      expected_rate_version_id: {
        type: 'string',
        description: 'Exact rate_version_id returned by exchange_rates.get_current.',
        required: true,
      },
      region: {
        type: 'string',
        description: 'Optional legacy context only.',
        required: false,
      },
      settlement: {
        type: 'enum',
        description: 'Optional legacy context only.',
        values: ['cash', 'bank', 'wallet', 'other'],
        required: false,
      },
    },
    outputSchema: {
      description:
        '{ trade_request: { request_id, code, status, pair_id, base_currency, quote_currency, customer_side, rate_version_id, effective_rate, base_amount, quote_amount, idempotent } }',
    },
    permission: 'propose',
    risk: 'medium',
    allowedPlanes: ['customer'],
    requiredCapabilities: ['rates.trade_request'],
    supportedGrantConstraints: ['currencies'],
    sideEffect: 'proposal',
    approvalRequired: false,
    idempotent: true,
    audit: 'proposal_and_execution',
    modelExposed: true,
    serverOnly: false,
    examples: [],
    errorContract: STANDARD_PLATFORM_TOOL_ERRORS,
  }),
  defineFxTool({
    key: 'exchange_rates.admin_list_pairs',
    version: 1,
    domain: 'exchange_rates',
    title: 'List FX V2 pairs',
    description:
      'Admin-only FX V2 view of explicit currency pairs, optimistic lock versions, and current immutable published rates.',
    purpose:
      'Inspect explicit FX V2 pairs, current immutable rate versions and optimistic lock versions.',
    whenToUse: [
      'A trusted administrator asks for current pair configuration or needs a fresh pair lock before proposing a rate change.',
    ],
    whenNotToUse: [
      'Do not read legacy Rate Books and do not use a stale lock_version for a later proposal.',
    ],
    inputSchema: {
      status: {
        type: 'enum',
        description: 'Optional pair status.',
        values: ['active', 'archived'],
        required: false,
      },
      limit: {
        type: 'number',
        description: 'Default 50, max 100.',
        required: false,
      },
    },
    outputSchema: {
      description:
        'Array<{ pair_id, base_currency, quote_currency, status, lock_version, current_rate, updated_at }>',
    },
    permission: 'read',
    risk: 'read',
    allowedPlanes: ['admin'],
    requiredCapabilities: ['rates.read'],
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
  defineFxTool({
    key: 'exchange_rates.propose_pair_change',
    version: 2,
    domain: 'exchange_rates',
    title: 'Propose FX V2 rate change',
    description:
      'Admin-only proposal to publish a new immutable FX V2 rate version for one explicit pair. The proposal is bound to the pair optimistic lock and requires human approval before execution.',
    purpose:
      'Create an approval-bound proposal to publish a new immutable FX V2 rate version for one pair.',
    whenToUse: [
      'First read the pair with exchange_rates.admin_list_pairs, then pass pair_id, exact expected_lock_version, business buy rate and business sell rate.',
    ],
    whenNotToUse: [
      'Never bypass human approval; never guess pair_id/lock_version; never mutate an existing immutable rate version.',
    ],
    inputSchema: {
      pair_id: {
        type: 'string',
        description: 'FX V2 pair UUID returned by exchange_rates.admin_list_pairs.',
        required: true,
      },
      expected_lock_version: {
        type: 'number',
        description: 'Exact pair lock_version returned by the preceding read.',
        required: true,
      },
      business_buy_rate: {
        type: 'string',
        description: 'Positive rate at which the business buys BASE from the customer.',
        required: true,
      },
      business_sell_rate: {
        type: 'string',
        description: 'Positive rate at which the business sells BASE to the customer.',
        required: true,
      },
      notes_internal: {
        type: 'string',
        description: 'Optional internal note.',
        required: false,
      },
    },
    outputSchema: { description: '{ pair, proposed_rate, change_request }' },
    permission: 'propose',
    risk: 'high',
    allowedPlanes: ['admin'],
    requiredCapabilities: ['rates.propose'],
    supportedGrantConstraints: ['currencies'],
    sideEffect: 'proposal',
    approvalRequired: true,
    idempotent: true,
    audit: 'proposal_and_execution',
    modelExposed: true,
    serverOnly: false,
    examples: [],
    errorContract: STANDARD_PLATFORM_TOOL_ERRORS,
  }),
  defineFxTool({
    key: 'exchange_rates.admin_list_trade_requests',
    version: 1,
    domain: 'exchange_rates',
    title: 'List FX V2 trade requests',
    description:
      'Admin-only operational view of FX V2 trade requests with snapshotted pair, rate version, effective rate and amounts.',
    purpose:
      'Inspect customer FX V2 trade requests and their snapshotted rate/amount facts.',
    whenToUse: ['A trusted administrator needs pending or historical FX trade requests.'],
    whenNotToUse: ['Do not treat a pending request as approved or completed.'],
    inputSchema: {
      status: {
        type: 'enum',
        description: 'Optional lifecycle status.',
        values: [
          'pending_admin',
          'approved_for_contact',
          'rejected',
          'completed',
          'cancelled',
        ],
        required: false,
      },
      limit: {
        type: 'number',
        description: 'Default 50, max 100.',
        required: false,
      },
    },
    outputSchema: {
      description:
        'Array<{ request_id, code, pair_id, base_currency, quote_currency, side, requested_amount, rate_version_id, effective_rate, base_amount, quote_amount, status, contact_id, conversation_id, created_at }>',
    },
    permission: 'read',
    risk: 'read',
    allowedPlanes: ['admin'],
    requiredCapabilities: ['rates.read'],
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
  defineFxTool({
    key: 'exchange_rates.propose_trade_decision',
    version: 1,
    domain: 'exchange_rates',
    title: 'Propose FX trade decision',
    description:
      'Admin-only proposal to approve a pending FX V2 trade request for customer contact or reject it. Approval does NOT mean settlement completed.',
    purpose:
      'Create an approval-bound proposal to approve a pending FX request for contact or reject it.',
    whenToUse: [
      'After reading a pending_admin trade request, a trusted administrator explicitly instructs approve or reject.',
    ],
    whenNotToUse: [
      'Never decide without explicit administrator intent; approval means approved_for_contact only and never settlement completed.',
    ],
    inputSchema: {
      request_id: {
        type: 'string',
        description: 'Pending FX trade request UUID.',
        required: true,
      },
      decision: {
        type: 'enum',
        description: 'Administrative decision.',
        values: ['approve', 'reject'],
        required: true,
      },
      note: {
        type: 'string',
        description: 'Optional internal decision note.',
        required: false,
      },
    },
    outputSchema: {
      description: '{ trade_request, proposed_decision, change_request }',
    },
    permission: 'propose',
    risk: 'high',
    allowedPlanes: ['admin'],
    requiredCapabilities: ['rates.propose'],
    supportedGrantConstraints: ['channels'],
    sideEffect: 'proposal',
    approvalRequired: true,
    idempotent: true,
    audit: 'proposal_and_execution',
    modelExposed: true,
    serverOnly: false,
    examples: [],
    errorContract: STANDARD_PLATFORM_TOOL_ERRORS,
  }),
]
