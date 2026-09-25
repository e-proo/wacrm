import type { ModelToolExecutorRegistration } from '@/lib/ai/tools/platform/runtime-contracts'
import { executeServicesGetSafe, executeServicesSearchSafe } from '@/lib/ai/tools/service-search'
import { executeServicesMatchRequest } from '@/lib/ai/tools/executors'
import { executeServiceProposeUpdate } from '@/lib/ai/tools/business-handoff'

export const SERVICES_MODEL_TOOL_EXECUTORS: readonly ModelToolExecutorRegistration[] = [
  { key: 'services.search', version: 1, executor: (ctx, args) => executeServicesSearchSafe(ctx, args as never) },
  { key: 'services.get', version: 1, executor: (ctx, args) => executeServicesGetSafe(ctx, args as never) },
  { key: 'services.match_request', version: 1, executor: (ctx, args) => executeServicesMatchRequest(ctx, args as never) },
  { key: 'services.propose_update', version: 1, executor: (ctx, args) => executeServiceProposeUpdate(ctx, args as never) },
]
