import type { ModelToolExecutorRegistration } from '@/lib/ai/tools/platform/runtime-contracts'
import { executePricingRuleProposeServicePrice } from '@/lib/ai/tools/business-handoff'

export const PRICING_RULES_MODEL_TOOL_EXECUTORS: readonly ModelToolExecutorRegistration[] = [
  {
    key: 'pricing_rules.propose_service_price',
    version: 1,
    executor: (ctx, args) => executePricingRuleProposeServicePrice(ctx, args as never),
  },
]
