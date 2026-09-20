import { COVERAGE_DOMAIN, COVERAGE_RUNTIME } from '@/lib/services/coverage/domain'
import { FX_V2_DOMAIN, FX_V2_RUNTIME } from '@/lib/services/fx-v2/domain'
import { ChangeExecutorRegistry } from './change-executor-registry'
import type {
  ChangeExecutionContext,
  ClaimedChangeExecution,
  ChangeExecutionResult,
} from './change-executor-registry'
import { BusinessDomainRegistry } from './domain-registry'
import type { BusinessDomainManifest, BusinessDomainRuntime } from './domain-contracts'

const DOMAIN_MODULES: readonly BusinessDomainManifest[] = [
  FX_V2_DOMAIN,
  COVERAGE_DOMAIN,
]

const DOMAIN_RUNTIMES: readonly BusinessDomainRuntime<never, never>[] = [
  FX_V2_RUNTIME,
  COVERAGE_RUNTIME,
]

export const CURRENT_BUSINESS_DOMAIN_REGISTRY = new BusinessDomainRegistry()
for (const domain of DOMAIN_MODULES) CURRENT_BUSINESS_DOMAIN_REGISTRY.register(domain)

export const CURRENT_CHANGE_EXECUTOR_REGISTRY = new ChangeExecutorRegistry()

for (const runtime of DOMAIN_RUNTIMES) {
  const domain = CURRENT_BUSINESS_DOMAIN_REGISTRY.getDomain(runtime.key)
  if (!domain) throw new Error('Runtime has no registered domain manifest: ' + runtime.key)
  if (domain.version !== runtime.version) {
    throw new Error(
      'Domain/runtime version mismatch for ' +
        runtime.key +
        ': manifest=' +
        domain.version +
        ', runtime=' +
        runtime.version,
    )
  }

  for (const registration of runtime.changeExecutors) {
    const action = CURRENT_BUSINESS_DOMAIN_REGISTRY.getChangeAction(
      registration.actionKey,
      registration.actionVersion,
    )
    if (!action) {
      throw new Error(
        'Cannot register change executor without action contract: ' +
          registration.actionKey +
          '@' +
          registration.actionVersion,
      )
    }
    if (action.domain !== runtime.key) {
      throw new Error(
        'Change executor domain mismatch: ' +
          registration.actionKey +
          ' belongs to ' +
          action.domain +
          ', runtime is ' +
          runtime.key,
      )
    }
    CURRENT_CHANGE_EXECUTOR_REGISTRY.register(registration)
  }
}

export type CurrentChangeExecutionAttempt =
  | { matched: false }
  | { matched: true; result: ChangeExecutionResult }

export async function tryExecuteCurrentChangeAction(
  context: ChangeExecutionContext,
  change: ClaimedChangeExecution,
): Promise<CurrentChangeExecutionAttempt> {
  const action = CURRENT_BUSINESS_DOMAIN_REGISTRY.resolveLegacyChangeAction({
    targetType: change.targetType,
    targetId: change.targetId,
    intent: change.intent,
  })
  if (!action) return { matched: false }

  if (!CURRENT_CHANGE_EXECUTOR_REGISTRY.has(action.key, action.version)) {
    throw new Error('CHANGE_EXECUTOR_NOT_REGISTERED:' + action.key + '@' + action.version)
  }

  return {
    matched: true,
    result: await CURRENT_CHANGE_EXECUTOR_REGISTRY.execute(
      action.key,
      action.version,
      context,
      change,
    ),
  }
}
