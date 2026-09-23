import {
  assertValidToolManifest,
  type PlatformToolManifest,
} from '@/lib/ai/tools/platform/contracts'
import { STANDARD_PLATFORM_TOOL_ERRORS } from '@/lib/services/platform/tool-contract-defaults'

function defineIntentTool(tool: PlatformToolManifest): PlatformToolManifest {
  return assertValidToolManifest(tool)
}

export const INTENTS_TOOL_MANIFESTS: readonly PlatformToolManifest[] = [
  defineIntentTool({
    key: 'intents.record',
    version: 1,
    domain: 'intents',
    title: 'Record customer intent',
    description:
      "Record a general observation about a customer's need or offer — even for services NOT equipped yet. Optionally escalates to the trusted admin for a decision.",
    purpose:
      'Persist a structured customer need/offer the configured services cannot yet resolve.',
    whenToUse: [
      'A business need or offer should be remembered or forwarded for administrative review.',
    ],
    whenNotToUse: [
      'Do not treat a generic intent as an approved authoritative business mutation.',
    ],
    inputSchema: {
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
        description: 'Short label of the service.',
        required: true,
      },
      summary: {
        type: 'string',
        description: 'One-paragraph human summary for the admin.',
        required: false,
      },
      attributes: {
        type: 'object',
        description: 'Key/value details the agent understood.',
        required: false,
      },
      escalate_to_admin: {
        type: 'boolean',
        description: 'True when the intent should be marked for admin review.',
        required: false,
      },
    },
    outputSchema: {
      description:
        '{ intent_id, status, change_request?: { id, code, confirmation_code } }',
    },
    permission: 'propose',
    risk: 'low',
    allowedPlanes: ['customer', 'admin'],
    requiredCapabilities: ['intents.propose'],
    supportedGrantConstraints: ['channels'],
    sideEffect: 'proposal',
    approvalRequired: false,
    idempotent: true,
    audit: 'proposal_and_execution',
    modelExposed: true,
    serverOnly: false,
    examples: [],
    errorContract: STANDARD_PLATFORM_TOOL_ERRORS,
  }),
  defineIntentTool({
    key: 'intents.search',
    version: 1,
    domain: 'intents',
    title: 'Search customer intents',
    description:
      "Search the account's recorded customer intents (general memory) by contact, status, or free text.",
    purpose: 'Inspect the structured admin inbox of customer needs and offers.',
    whenToUse: [
      'Administration asks what customer requests or offers are waiting or recorded.',
    ],
    whenNotToUse: [
      'Do not expose the administrative intent queue to the customer plane.',
    ],
    inputSchema: {
      contact_id: {
        type: 'string',
        description: 'Restrict to one contact.',
        required: false,
      },
      status: {
        type: 'enum',
        description: 'Filter by lifecycle status.',
        values: [
          'new',
          'clarifying',
          'forwarded_to_admin',
          'fulfilled',
          'rejected',
          'matched',
        ],
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
    outputSchema: {
      description:
        'Array<{ intent_id, contact_id, conversation_id, direction, service_hint, summary, status, attributes, matched_service_id, created_at }>',
    },
    permission: 'read',
    risk: 'read',
    allowedPlanes: ['admin'],
    requiredCapabilities: ['intents.read'],
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
  defineIntentTool({
    key: 'intents.propose_decision',
    version: 1,
    domain: 'intents',
    title: 'Propose intent decision',
    description:
      'Admin-only proposal for resolving a generic customer intent after review.',
    purpose:
      'Create a typed proposal to resolve, match, reject, or clarify a customer intent.',
    whenToUse: [
      'A trusted administrator has reviewed an intent and explicitly instructs a decision.',
    ],
    whenNotToUse: [
      'Do not resolve a customer intent without the explicit administrator decision.',
    ],
    inputSchema: {
      intent_id: {
        type: 'string',
        description: 'Customer intent UUID.',
        required: true,
      },
      decision: {
        type: 'enum',
        description: 'Resolution.',
        values: ['fulfilled', 'rejected', 'matched', 'clarifying'],
        required: true,
      },
      matched_service_id: {
        type: 'string',
        description: 'Required when decision=matched.',
        required: false,
      },
      reason: {
        type: 'string',
        description: 'Optional admin-facing rationale.',
        required: false,
      },
    },
    outputSchema: {
      description:
        '{ change_request: { id, code, confirmation_code, status } }',
    },
    permission: 'propose',
    risk: 'medium',
    allowedPlanes: ['admin'],
    requiredCapabilities: ['intents.propose'],
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
