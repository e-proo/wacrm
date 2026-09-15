import {
  executeCoverageCheckAvailability,
  executeExchangeRatesGetCurrent,
  executePricingCalculateQuote,
  executeServicesMatchRequest,
  executeIntentsRecord,
  executeIntentsSearch,
  type ToolContext,
  type ToolResult,
} from '../executors'
import { executeServicesGetSafe, executeServicesSearchSafe } from '../service-search'
import {
  executeCoverageAdminListOffers,
  executeCoverageAdminListRequests,
  executeChangeRequestsListPending,
  executeIntentProposeDecision,
  executeExchangeRateRecordTradeRequest,
  executeExchangeRateAdminListBooks,
  executeExchangeRateProposePairChange,
  executeServiceProposeUpdate,
  executePricingRuleProposeServicePrice,
} from '../business-handoff'
import {
  executeCoverageDirectionalProposal,
  executeCoverageFindOffersDirectional,
  executeCoverageGetRatesDirectional,
} from '../coverage-directional'
import type { ToolDefinition } from '../../runtime/tool-registry'
import { ToolExecutorRegistry } from './execution-registry'
import { getCurrentPlatformTool } from './current-domain-registry'

type RuntimeResult = ToolResult<unknown>
type RuntimeExecutor = (ctx: ToolContext, args: Record<string, unknown>) => Promise<RuntimeResult>

const CURRENT_EXECUTORS = new ToolExecutorRegistry<ToolContext, RuntimeResult>()

function add(key: string, version: number, executor: RuntimeExecutor): void {
  const contract = getCurrentPlatformTool(key, version)
  if (!contract) throw new Error(`Cannot register executor without platform contract: ${key}@${version}`)
  CURRENT_EXECUTORS.register({ key, version, executor })
}

add('services.search', 1, (ctx, args) => executeServicesSearchSafe(ctx, args as never))
add('services.get', 1, (ctx, args) => executeServicesGetSafe(ctx, args as never))
add('services.match_request', 1, (ctx, args) => executeServicesMatchRequest(ctx, args as never))
add('services.propose_update', 1, (ctx, args) => executeServiceProposeUpdate(ctx, args as never))
add('pricing.calculate_quote', 1, (ctx, args) => executePricingCalculateQuote(ctx, args as never))
add('pricing_rules.propose_service_price', 1, (ctx, args) => executePricingRuleProposeServicePrice(ctx, args as never))
add('exchange_rates.get_current', 1, (ctx, args) => executeExchangeRatesGetCurrent(ctx, args as never))
add('exchange_rates.record_trade_request', 1, (ctx, args) => executeExchangeRateRecordTradeRequest(ctx, args as never))
add('exchange_rates.admin_list_books', 1, (ctx, args) => executeExchangeRateAdminListBooks(ctx, args as never))
add('exchange_rates.propose_pair_change', 1, (ctx, args) => executeExchangeRateProposePairChange(ctx, args as never))
add('coverage.check_availability', 1, (ctx, args) => executeCoverageCheckAvailability(ctx, args as never))
add('coverage.find_offers', 2, (ctx, args) => {
  const hasDirectionalLegs = Boolean(
    (args.pay_region_id || args.pay_region || args.pay_macro) &&
      (args.receive_region_id || args.receive_region || args.receive_macro),
  )
  // The legacy finder applies its limit before the directional wrapper checks
  // the anti-parallel pay leg. For a concrete two-leg request, widen the
  // internal scan to the executor maximum so a valid offer cannot be hidden
  // merely because unrelated receive-leg rows happened to sort first.
  const effectiveArgs = hasDirectionalLegs ? { ...args, limit: 50 } : args
  return executeCoverageFindOffersDirectional(ctx, effectiveArgs as never)
})
add('coverage.get_rates', 1, (ctx, args) => executeCoverageGetRatesDirectional(ctx, args as never))
add('coverage.propose_offer', 2, (ctx, args) => executeCoverageDirectionalProposal(ctx, args as never, 'offer'))
add('coverage.propose_request', 1, (ctx, args) => executeCoverageDirectionalProposal(ctx, args as never, 'request'))
add('coverage.admin_list_offers', 1, (ctx, args) => executeCoverageAdminListOffers(ctx, args as never))
add('coverage.admin_list_requests', 1, (ctx, args) => executeCoverageAdminListRequests(ctx, args as never))
add('intents.record', 1, (ctx, args) => executeIntentsRecord(ctx, args as never))
add('intents.search', 1, (ctx, args) => executeIntentsSearch(ctx, args as never))
add('intents.propose_decision', 1, (ctx, args) => executeIntentProposeDecision(ctx, args as never))
add('change_requests.list_pending', 1, (ctx, args) => executeChangeRequestsListPending(ctx, args as never))

const MODEL_SECRET_KEYS = new Set([
  'confirmation_code',
  'confirmationCode',
  'confirmation_code_hash',
  'confirmationCodeHash',
])

function stripModelSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripModelSecrets)
  if (!value || typeof value !== 'object') return value

  const clean: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (MODEL_SECRET_KEYS.has(key)) continue
    clean[key] = stripModelSecrets(child)
  }
  return clean
}

/**
 * Final model-boundary projection. Approval credentials are transport secrets
 * for a verified human administrator, never model context — even when a
 * domain executor accidentally includes them in a proposal DTO.
 */
export function sanitizeToolResultForModel(result: RuntimeResult): RuntimeResult {
  if (result.data == null) return result
  return { ...result, data: stripModelSecrets(result.data) }
}

/**
 * Dispatch after schema/grant/policy validation. Exact version is mandatory;
 * registered manifests and registered executors must move together.
 */
export async function executeCurrentPlatformTool(
  ctx: ToolContext,
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Promise<RuntimeResult> {
  const contract = getCurrentPlatformTool(tool.key, tool.version)
  if (!contract) {
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'TOOL_CONTRACT_MISSING',
      message: 'Tool is not available.',
    }
  }
  if (!CURRENT_EXECUTORS.has(tool.key, tool.version)) {
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'TOOL_EXECUTOR_MISSING',
      message: 'Tool is not available.',
    }
  }
  const result = await CURRENT_EXECUTORS.execute(tool.key, tool.version, ctx, args)
  return sanitizeToolResultForModel(result)
}
