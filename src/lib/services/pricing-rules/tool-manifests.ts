import {
  assertValidToolManifest,
  type PlatformToolManifest,
} from '@/lib/ai/tools/platform/contracts'
import { STANDARD_PLATFORM_TOOL_ERRORS } from '@/lib/services/platform/tool-contract-defaults'

export const PRICING_RULES_TOOL_MANIFESTS: readonly PlatformToolManifest[] = [
  assertValidToolManifest({
    key: 'pricing_rules.propose_service_price',
    version: 1,
    domain: 'pricing_rules',
    title: 'Propose service price',
    description:
      'Admin-only proposal to create a new immutable pricing rule and attach it through a new service revision after approval.',
    purpose:
      'Create a typed proposal for a new immutable pricing rule/service revision.',
    whenToUse: ['A trusted administrator explicitly supplies a pricing change.'],
    whenNotToUse: ['Never expose it to customers and never directly overwrite the live pricing row.'],
    inputSchema: {
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
    outputSchema: { description: '{ service, proposed_pricing_rule, change_request }' },
    permission: 'propose',
    risk: 'high',
    allowedPlanes: ['admin'],
    requiredCapabilities: ['pricing.propose'],
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
