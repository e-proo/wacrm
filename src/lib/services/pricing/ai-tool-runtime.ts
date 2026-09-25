import type { ModelToolExecutorRegistration } from '@/lib/ai/tools/platform/runtime-contracts'
import { executePricingCalculateQuote } from '@/lib/ai/tools/executors'

export const PRICING_MODEL_TOOL_EXECUTORS: readonly ModelToolExecutorRegistration[] = [
  { key: 'pricing.calculate_quote', version: 1, executor: (ctx, args) => executePricingCalculateQuote(ctx, args as never) },
]
