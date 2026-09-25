import {
  defineBusinessDomain,
  defineBusinessDomainRuntime,
} from '@/lib/services/platform/domain-contracts'
import { PRICING_RULES_MODEL_TOOL_EXECUTORS } from './ai-tool-runtime'
import { PRICING_RULES_CHANGE_EXECUTORS } from './change-executors'
import { PRICING_RULES_TOOL_MANIFESTS } from './tool-manifests'

export const PRICING_RULES_DOMAIN = defineBusinessDomain({
  key: 'pricing_rules',
  version: 1,
  title: 'Pricing Rules',
  description:
    'Admin-reviewed immutable pricing-rule proposals and deterministic approved pricing mutations.',
  capabilities: ['pricing.propose'],
  tools: PRICING_RULES_TOOL_MANIFESTS,
  changeActions: [
    {
      key: 'pricing_rules.create_and_attach',
      version: 1,
      domain: 'pricing_rules',
      title: 'Create and attach approved service pricing rule',
      description:
        'Creates a new immutable pricing rule and publishes a new service revision after explicit approval.',
      approvalRequired: true,
      idempotent: true,
      legacySelectors: [
        { targetType: 'pricing_rule', intent: 'create_and_attach', targetId: 'absent' },
      ],
    },
    {
      key: 'pricing_rules.publish',
      version: 1,
      domain: 'pricing_rules',
      title: 'Publish approved pricing rule',
      description:
        'Publishes an approved draft pricing rule through the deterministic pricing-rule executor.',
      approvalRequired: true,
      idempotent: true,
      legacySelectors: [
        { targetType: 'pricing_rule', intent: 'publish', targetId: 'present' },
      ],
    },
  ],
  events: [],
  messageTemplates: [],
})

export const PRICING_RULES_RUNTIME = defineBusinessDomainRuntime({
  key: 'pricing_rules',
  version: 1,
  toolExecutors: PRICING_RULES_MODEL_TOOL_EXECUTORS,
  changeExecutors: PRICING_RULES_CHANGE_EXECUTORS,
  eventProjectors: [],
})
