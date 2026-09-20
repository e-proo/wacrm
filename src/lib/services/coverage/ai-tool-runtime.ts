import type { ModelToolExecutorRegistration } from '@/lib/ai/tools/platform/runtime-contracts'
import {
  executeCoverageCheckAvailability,
} from '@/lib/ai/tools/executors'
import {
  executeCoverageAdminListOffers,
  executeCoverageAdminListRequests,
} from '@/lib/ai/tools/business-handoff'
import {
  executeCoverageFindOffersDirectional,
  executeCoverageGetRatesDirectional,
} from '@/lib/ai/tools/coverage-directional'
import { executeCoverageProposalResilient } from '@/lib/ai/tools/coverage-proposal-resilient'

export const COVERAGE_MODEL_TOOL_EXECUTORS: readonly ModelToolExecutorRegistration[] = [
  {
    key: 'coverage.check_availability',
    version: 1,
    executor: (ctx, args) => executeCoverageCheckAvailability(ctx, args as never),
  },
  {
    key: 'coverage.find_offers',
    version: 2,
    executor: (ctx, args) => {
      const hasDirectionalLegs = Boolean(
        (args.pay_region_id || args.pay_region || args.pay_macro) &&
          (args.receive_region_id || args.receive_region || args.receive_macro),
      )
      const effectiveArgs = hasDirectionalLegs ? { ...args, limit: 50 } : args
      return executeCoverageFindOffersDirectional(ctx, effectiveArgs as never)
    },
  },
  {
    key: 'coverage.get_rates',
    version: 1,
    executor: (ctx, args) => executeCoverageGetRatesDirectional(ctx, args as never),
  },
  {
    key: 'coverage.propose_offer',
    version: 2,
    executor: (ctx, args) => executeCoverageProposalResilient(ctx, args, 'offer'),
  },
  {
    key: 'coverage.propose_request',
    version: 1,
    executor: (ctx, args) => executeCoverageProposalResilient(ctx, args, 'request'),
  },
  {
    key: 'coverage.admin_list_offers',
    version: 1,
    executor: (ctx, args) => executeCoverageAdminListOffers(ctx, args as never),
  },
  {
    key: 'coverage.admin_list_requests',
    version: 1,
    executor: (ctx, args) => executeCoverageAdminListRequests(ctx, args as never),
  },
]
