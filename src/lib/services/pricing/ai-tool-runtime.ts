import type { ModelToolExecutorRegistration } from '@/lib/ai/tools/platform/runtime-contracts'
import type { ToolContext, ToolResult } from '@/lib/ai/tools/executors'
import { previewServiceQuote } from '@/lib/services/domain-services'

interface PricingCalculateQuoteArgs {
  service_id: string
  amount: string
  currency: string
  attributes?: Record<string, unknown>
}

export async function executePricingCalculateQuote(
  ctx: ToolContext,
  args: PricingCalculateQuoteArgs,
): Promise<ToolResult<unknown>> {
  if (!args.service_id || !args.amount || !args.currency) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message: 'service_id, amount, and currency are required.',
    }
  }

  try {
    const quote = await previewServiceQuote({
      accountId: ctx.accountId,
      serviceId: args.service_id,
      amount: args.amount,
      currency: args.currency,
      attributes: args.attributes,
    })
    return { ok: true, data: quote, safe_to_show: true }
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'QUOTE_FAILED'
    const message = (err as { message?: string }).message ?? 'Quote failed.'
    const safeToShow = new Set([
      'SERVICE_NOT_FOUND',
      'SERVICE_NOT_ACTIVE',
      'NO_PRICING_RULE',
      'INVALID_RULE',
      'INVALID_INPUT',
    ]).has(code)
    return {
      ok: false,
      data: null,
      safe_to_show: safeToShow,
      code,
      message,
    }
  }
}

export const PRICING_MODEL_TOOL_EXECUTORS: readonly ModelToolExecutorRegistration[] = [
  {
    key: 'pricing.calculate_quote',
    version: 1,
    executor: (ctx, args) => executePricingCalculateQuote(ctx, args as never),
  },
]
