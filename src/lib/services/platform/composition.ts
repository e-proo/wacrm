import { COVERAGE_DOMAIN, COVERAGE_RUNTIME } from '@/lib/services/coverage/domain'
import { FX_V2_DOMAIN, FX_V2_RUNTIME } from '@/lib/services/fx-v2/domain'
import { ChangeExecutorRegistry } from './change-executor-registry'
import { EventProjectorRegistry } from './event-projector-registry'
import { PLATFORM_GENERIC_BUSINESS_EVENT_MANIFESTS } from './generic-business-events'
import { PLATFORM_GENERIC_EVENT_PROJECTORS } from './generic-message-projectors'
import type {
  ChangeExecutionContext,
  ClaimedChangeExecution,
  ChangeExecutionResult,
} from './change-executor-registry'
import { BusinessDomainRegistry } from './domain-registry'
import type { BusinessDomainManifest } from './domain-contracts'

export const CURRENT_BUSINESS_DOMAIN_MODULES: readonly BusinessDomainManifest[] = [
  FX_V2_DOMAIN,
  COVERAGE_DOMAIN,
]

export const CURRENT_BUSINESS_DOMAIN_RUNTIMES = [
  FX_V2_RUNTIME,
  COVERAGE_RUNTIME,
] as const

export const CURRENT_BUSINESS_DOMAIN_REGISTRY = new BusinessDomainRegistry()
for (const domain of CURRENT_BUSINESS_DOMAIN_MODULES) {
  CURRENT_BUSINESS_DOMAIN_REGISTRY.register(domain)
}

export const CURRENT_CHANGE_EXECUTOR_REGISTRY = new ChangeExecutorRegistry()
export const CURRENT_EVENT_PROJECTOR_REGISTRY = new EventProjectorRegistry()

for (const runtime of CURRENT_BUSINESS_DOMAIN_RUNTIMES) {
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

  for (const registration of runtime.eventProjectors) {
    const event = CURRENT_BUSINESS_DOMAIN_REGISTRY.getEvent(
      registration.eventType,
      registration.eventVersion,
    )
    if (!event) {
      throw new Error(
        'Cannot register event projector without event contract: ' +
          registration.eventType +
          '@' +
          registration.eventVersion,
      )
    }
    if (event.domain !== runtime.key) {
      throw new Error(
        'Event projector domain mismatch: ' +
          registration.eventType +
          ' belongs to ' +
          event.domain +
          ', runtime is ' +
          runtime.key,
      )
    }
    CURRENT_EVENT_PROJECTOR_REGISTRY.register(registration)
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


const PLATFORM_GENERIC_EVENT_BY_ID = new Map(
  PLATFORM_GENERIC_BUSINESS_EVENT_MANIFESTS.map((event) => [
    event.key + '@' + event.version,
    event,
  ]),
)

for (const registration of PLATFORM_GENERIC_EVENT_PROJECTORS) {
  const id = registration.eventType + '@' + registration.eventVersion
  const event = PLATFORM_GENERIC_EVENT_BY_ID.get(id)
  if (!event) {
    throw new Error('Cannot register platform event projector without event contract: ' + id)
  }
  if (event.domain !== 'platform') {
    throw new Error('Platform event projector manifest must belong to platform: ' + id)
  }
  CURRENT_EVENT_PROJECTOR_REGISTRY.register(registration)
}
