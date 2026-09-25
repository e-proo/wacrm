import {
  defineBusinessDomain,
  defineBusinessDomainRuntime,
} from '@/lib/services/platform/domain-contracts'
import { SERVICES_MODEL_TOOL_EXECUTORS } from './ai-tool-runtime'
import { SERVICES_CHANGE_EXECUTORS } from './change-executors'
import { SERVICES_TOOL_MANIFESTS } from './tool-manifests'

export const SERVICES_DOMAIN = defineBusinessDomain({
  key: 'services',
  version: 1,
  title: 'Service Catalog',
  description:
    'Service discovery, matching, revision proposals, and deterministic approved service revision publication.',
  capabilities: ['services.read', 'services.propose'],
  tools: SERVICES_TOOL_MANIFESTS,
  changeActions: [
    {
      key: 'services.update',
      version: 1,
      domain: 'services',
      title: 'Publish approved service revision update',
      description:
        'Validates and deterministically publishes an approved service revision update.',
      approvalRequired: true,
      idempotent: true,
      legacySelectors: [
        { targetType: 'service', intent: 'update', targetId: 'present' },
      ],
    },
  ],
  events: [],
  messageTemplates: [],
})

export const SERVICES_RUNTIME = defineBusinessDomainRuntime({
  key: 'services',
  version: 1,
  toolExecutors: SERVICES_MODEL_TOOL_EXECUTORS,
  changeExecutors: SERVICES_CHANGE_EXECUTORS,
  eventProjectors: [],
})
