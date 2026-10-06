import {
  assertValidToolManifest,
  type PlatformToolManifest,
} from '@/lib/ai/tools/platform/contracts'
import { STANDARD_PLATFORM_TOOL_ERRORS } from '@/lib/services/platform/tool-contract-defaults'

export const CHANGE_REQUEST_TOOL_MANIFESTS: readonly PlatformToolManifest[] = [
  assertValidToolManifest({
    key: 'change_requests.list_pending',
    version: 1,
    domain: 'change_requests',
    title: 'List pending changes',
    description:
      'Admin-only list of pending proposed system changes awaiting a human decision.',
    purpose: 'Inspect pending typed proposals awaiting a human decision.',
    whenToUse: ['A trusted administrator asks what changes await approval.'],
    whenNotToUse: ['Do not interpret listing a proposal as approving it.'],
    inputSchema: {
      limit: {
        type: 'number',
        description: 'Default 20, max 100.',
        required: false,
      },
    },
    outputSchema: {
      description:
        'Array<{ id, code, target_type, intent, summary, proposed_payload, created_at, expires_at }>',
    },
    permission: 'read',
    risk: 'read',
    allowedPlanes: ['admin'],
    requiredCapabilities: ['change_requests.read'],
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
