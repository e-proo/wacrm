import type { ModelToolExecutorRegistration } from '@/lib/ai/tools/platform/runtime-contracts'
import {
  executeFxV2GetCurrent,
  executeFxV2RecordTradeRequest,
} from '@/lib/ai/tools/fx-v2-tools'
import {
  executeFxV2AdminListPairs,
  executeFxV2AdminListTradeRequests,
  executeFxV2ProposePairChange,
  executeFxV2ProposeTradeDecision,
} from '@/lib/ai/tools/fx-v2-admin-tools'

export const FX_V2_MODEL_TOOL_EXECUTORS: readonly ModelToolExecutorRegistration[] = [
  {
    key: 'exchange_rates.get_current',
    version: 1,
    executor: (ctx, args) => executeFxV2GetCurrent(ctx, args as never),
  },
  {
    key: 'exchange_rates.record_trade_request',
    version: 2,
    executor: (ctx, args) => executeFxV2RecordTradeRequest(ctx, args as never),
  },
  {
    key: 'exchange_rates.admin_list_pairs',
    version: 1,
    executor: (ctx, args) => executeFxV2AdminListPairs(ctx, args as never),
  },
  {
    key: 'exchange_rates.propose_pair_change',
    version: 2,
    executor: (ctx, args) => executeFxV2ProposePairChange(ctx, args as never),
  },
  {
    key: 'exchange_rates.admin_list_trade_requests',
    version: 1,
    executor: (ctx, args) => executeFxV2AdminListTradeRequests(ctx, args as never),
  },
  {
    key: 'exchange_rates.propose_trade_decision',
    version: 1,
    executor: (ctx, args) => executeFxV2ProposeTradeDecision(ctx, args as never),
  },
]
