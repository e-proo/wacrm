import {
  defineBusinessDomain,
  defineBusinessDomainRuntime,
} from '@/lib/services/platform/domain-contracts'
import { CHANGE_REQUEST_MODEL_TOOL_EXECUTORS } from './ai-tool-runtime'
import { CHANGE_REQUEST_TOOL_MANIFESTS } from './tool-manifests'

export const CHANGE_REQUESTS_DOMAIN = defineBusinessDomain({
  key: 'change_requests',
  version: 1,
  title: 'Change Requests',
  description:
    'Shared approval-workflow reads exposed to trusted administrators through native platform tool contracts.',
  capabilities: ['change_requests.read'],
  tools: CHANGE_REQUEST_TOOL_MANIFESTS,
  changeActions: [],
  events: [],
  messageTemplates: [],
})

export const CHANGE_REQUESTS_RUNTIME = defineBusinessDomainRuntime({
  key: 'change_requests',
  version: 1,
  toolExecutors: CHANGE_REQUEST_MODEL_TOOL_EXECUTORS,
  changeExecutors: [],
  eventProjectors: [],
})
