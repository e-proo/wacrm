import {
  executeCoverageCheckAvailability,
  executeExchangeRatesGetCurrent,
  executePricingCalculateQuote,
  executeServicesGet,
  executeServicesSearch,
  executeServicesMatchRequest,
  executeIntentsRecord,
  executeIntentsSearch,
  executeCoverageFindOffers,
  executeCoverageGetRates,
  type ToolContext,
  type ToolResult,
} from '../executors'
import {
  executeCoverageProposeOfferIntegrated,
  executeCoverageProposeRequest,
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

add('services.search', 1, (ctx, args) => executeServicesSearch(ctx, args as never))
add('services.get', 1, (ctx, args) => executeServicesGet(ctx, args as never))
add('services.match_request', 1, (ctx, args) => executeServicesMatchRequest(ctx, args as never))
add('services.propose_update', 1, (ctx, args) => executeServiceProposeUpdate(ctx, args as never))
add('pricing.calculate_quote', 1, (ctx, args) => executePricingCalculateQuote(ctx, args as never))
add('pricing_rules.propose_service_price', 1, (ctx, args) => executePricingRuleProposeServicePrice(ctx, args as never))
add('exchange_rates.get_current', 1, (ctx, args) => executeExchangeRatesGetCurrent(ctx, args as never))
add('exchange_rates.record_trade_request', 1, (ctx, args) => executeExchangeRateRecordTradeRequest(ctx, args as never))
add('exchange_rates.admin_list_books', 1, (ctx, args) => executeExchangeRateAdminListBooks(ctx, args as never))
add('exchange_rates.propose_pair_change', 1, (ctx, args) => executeExchangeRateProposePairChange(ctx, args as never))
add('coverage.check_availability', 1, (ctx, args) => executeCoverageCheckAvailability(ctx, args as never))
add('coverage.find_offers', 2, (ctx, args) => executeCoverageFindOffers(ctx, args as never))
add('coverage.get_rates', 1, (ctx, args) => executeCoverageGetRates(ctx, args as never))
add('coverage.propose_offer', 2, (ctx, args) => executeCoverageProposeOfferIntegrated(ctx, args as never))
add('coverage.propose_request', 1, (ctx, args) => executeCoverageProposeRequest(ctx, args as never))
add('coverage.admin_list_offers', 1, (ctx, args) => executeCoverageAdminListOffers(ctx, args as never))
add('coverage.admin_list_requests', 1, (ctx, args) => executeCoverageAdminListRequests(ctx, args as never))
add('intents.record', 1, (ctx, args) => executeIntentsRecord(ctx, args as never))
add('intents.search', 1, (ctx, args) => executeIntentsSearch(ctx, args as never))
add('intents.propose_decision', 1, (ctx, args) => executeIntentProposeDecision(ctx, args as never))
add('change_requests.list_pending', 1, (ctx, args) => executeChangeRequestsListPending(ctx, args as never))

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
  return CURRENT_EXECUTORS.execute(tool.key, tool.version, ctx, args)
}
