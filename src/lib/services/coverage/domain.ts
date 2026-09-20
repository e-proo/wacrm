import { SYSTEM_MESSAGE_TEMPLATES } from '@/lib/messaging/defaults'
import {
  defineBusinessDomain,
  defineBusinessDomainRuntime,
} from '@/lib/services/platform/domain-contracts'
import { COVERAGE_MODEL_TOOL_EXECUTORS } from './ai-tool-runtime'
import { COVERAGE_CHANGE_EXECUTORS } from './change-executors'
import { COVERAGE_TOOL_MANIFESTS } from './tool-manifests'

const COVERAGE_TEMPLATE_KEYS = new Set([
  'coverage.offer.approved',
  'coverage.request.approved',
])

const coverageTemplates = SYSTEM_MESSAGE_TEMPLATES.filter((template) =>
  COVERAGE_TEMPLATE_KEYS.has(template.key),
)
if (coverageTemplates.length !== COVERAGE_TEMPLATE_KEYS.size) {
  throw new Error('Coverage domain is missing one or more system message templates.')
}

export const COVERAGE_DOMAIN = defineBusinessDomain({
  key: 'coverage',
  version: 1,
  title: 'Coverage',
  description:
    'Coverage marketplace domain: directional reads, customer proposals, admin operational reads, and deterministic approved offer/request creation.',
  capabilities: ['coverage.read', 'coverage.propose'],
  tools: COVERAGE_TOOL_MANIFESTS,
  changeActions: [
    {
      key: 'coverage.offer.create',
      version: 1,
      domain: 'coverage',
      title: 'Create approved coverage offer',
      description:
        'Creates an authoritative coverage offer from the exact payload of an approved change request.',
      approvalRequired: true,
      idempotent: true,
      legacySelectors: [
        { targetType: 'coverage_offer', intent: 'create', targetId: 'absent' },
      ],
    },
    {
      key: 'coverage.request.create',
      version: 1,
      domain: 'coverage',
      title: 'Create approved coverage request',
      description:
        'Creates an authoritative coverage request from the exact payload of an approved change request.',
      approvalRequired: true,
      idempotent: true,
      legacySelectors: [
        { targetType: 'coverage_request', intent: 'create', targetId: 'absent' },
      ],
    },
  ],
  events: [],
  messageTemplates: coverageTemplates,
})

export const COVERAGE_RUNTIME = defineBusinessDomainRuntime({
  key: 'coverage',
  version: 1,
  toolExecutors: COVERAGE_MODEL_TOOL_EXECUTORS,
  changeExecutors: COVERAGE_CHANGE_EXECUTORS,
  eventProjectors: [],
})
