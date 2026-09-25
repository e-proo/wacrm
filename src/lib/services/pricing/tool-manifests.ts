import {
  assertValidToolManifest,
  type PlatformToolManifest,
} from '@/lib/ai/tools/platform/contracts'
import { STANDARD_PLATFORM_TOOL_ERRORS } from '@/lib/services/platform/tool-contract-defaults'

export const PRICING_TOOL_MANIFESTS: readonly PlatformToolManifest[] = [
  assertValidToolManifest({
    key: 'pricing.calculate_quote',
    version: 1,
    domain: 'pricing',
    title: 'Calculate quote',
    description:
      'Compute a fee for a service + amount. Returns fee amount + currency + rendered facts. Does NOT mutate state.',
    purpose: 'Calculate a quote from the currently published pricing rule.',
    whenToUse: ['The service, amount, currency, and required pricing attributes are known.'],
    whenNotToUse: ['Do not invent missing inputs or use it to modify a pricing rule.'],
    inputSchema: {
      service_id: { type: 'string', description: 'Service UUID.', required: true },
      amount: { type: 'string', description: 'Amount as a decimal string (e.g. "10000.00").', required: true },
      currency: { type: 'string', description: 'ISO-4217-like 3-letter code.', required: true },
      attributes: { type: 'object', description: 'Service-specific attributes.', required: false },
    },
    outputSchema: { description: 'QuoteResult { status, feeAmount, feeCurrency, renderedFacts, inputAmount, inputCurrency, precision, audit }' },
    permission: 'read',
    risk: 'read',
    allowedPlanes: ['customer', 'admin'],
    requiredCapabilities: ['pricing.read'],
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
]
