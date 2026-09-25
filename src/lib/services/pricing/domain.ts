import {
  defineBusinessDomain,
  defineBusinessDomainRuntime,
} from '@/lib/services/platform/domain-contracts'
import { PRICING_MODEL_TOOL_EXECUTORS } from './ai-tool-runtime'
import { PRICING_TOOL_MANIFESTS } from './tool-manifests'

export const PRICING_DOMAIN = defineBusinessDomain({
  key: 'pricing',
  version: 1,
  title: 'Pricing',
  description:
    'Deterministic read-only pricing quotes from the published service pricing rule.',
  capabilities: ['pricing.read'],
  tools: PRICING_TOOL_MANIFESTS,
  changeActions: [],
  events: [],
  messageTemplates: [],
})

export const PRICING_RUNTIME = defineBusinessDomainRuntime({
  key: 'pricing',
  version: 1,
  toolExecutors: PRICING_MODEL_TOOL_EXECUTORS,
  changeExecutors: [],
  eventProjectors: [],
})
