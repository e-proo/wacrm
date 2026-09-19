import { FX_V2_DOMAIN, FX_V2_RUNTIME } from '@/lib/services/fx-v2/domain'
import { ChangeExecutorRegistry } from './change-executor-registry'
import type {
  ChangeExecutionContext,
  ClaimedChangeExecution,
  ChangeExecutionResult,
} from './change-executor-registry'
import { BusinessDomainRegistry } from './domain-registry'

export const CURRENT_BUSINESS_DOMAIN_REGISTRY = new BusinessDomainRegistry().register(FX_V2_DOMAIN)

export const CURRENT_CHANGE_EXECUTOR_REGISTRY = new ChangeExecutorRegistry()

for (const registration of FX_V2_RUNTIME.changeExecutors) {
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
  if (action.domain !== FX_V2_RUNTIME.key) {
    throw new Error(
      'Change executor domain mismatch: ' +
        registration.actionKey +
        ' belongs to ' +
        action.domain +
        ', runtime is ' +
        FX_V2_RUNTIME.key,
    )
  }
  CURRENT_CHANGE_EXECUTOR_REGISTRY.register(registration)
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
