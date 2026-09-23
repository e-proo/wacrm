import { SYSTEM_MESSAGE_TEMPLATES } from '@/lib/messaging/defaults'
import {
  defineBusinessDomain,
  defineBusinessDomainRuntime,
} from '@/lib/services/platform/domain-contracts'
import { INTENTS_MODEL_TOOL_EXECUTORS } from './ai-tool-runtime'
import { INTENT_BUSINESS_EVENT_MANIFESTS } from './business-events'
import { INTENTS_CHANGE_EXECUTORS } from './change-executors'
import { INTENT_EVENT_PROJECTORS } from './message-projectors'
import { INTENTS_TOOL_MANIFESTS } from './tool-manifests'

const INTENT_TEMPLATE_KEYS = new Set([
  'service_request.approved',
  'service_request.rejected',
  'service_request.matched',
  'service_request.needs_clarification',
  'service_request.completed',
])

const intentTemplates = SYSTEM_MESSAGE_TEMPLATES.filter((template) =>
  INTENT_TEMPLATE_KEYS.has(template.key),
)
if (intentTemplates.length !== INTENT_TEMPLATE_KEYS.size) {
  throw new Error('Intents domain is missing one or more system message templates.')
}

export const INTENTS_DOMAIN = defineBusinessDomain({
  key: 'intents',
  version: 1,
  title: 'Customer Intents',
  description:
    'Structured customer needs/offers, admin-reviewed intent decisions, and canonical service-request lifecycle messaging.',
  capabilities: ['intents.read', 'intents.propose'],
  tools: INTENTS_TOOL_MANIFESTS,
  changeActions: [
    {
      key: 'intents.decision.apply',
      version: 1,
      domain: 'intents',
      title: 'Apply approved customer intent decision',
      description:
        'Deterministically applies an approved fulfilled/rejected/matched/clarifying decision to an existing customer intent.',
      approvalRequired: true,
      idempotent: true,
      legacySelectors: [
        {
          targetType: 'service_intent',
          intent: 'update',
          targetId: 'present',
        },
      ],
    },
  ],
  events: INTENT_BUSINESS_EVENT_MANIFESTS,
  messageTemplates: intentTemplates,
})

export const INTENTS_RUNTIME = defineBusinessDomainRuntime({
  key: 'intents',
  version: 1,
  toolExecutors: INTENTS_MODEL_TOOL_EXECUTORS,
  changeExecutors: INTENTS_CHANGE_EXECUTORS,
  eventProjectors: INTENT_EVENT_PROJECTORS,
})
