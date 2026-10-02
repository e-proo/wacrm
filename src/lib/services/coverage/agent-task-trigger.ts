import type {
  AgentTaskTriggerDefinition,
  AgentTaskTriggerFiring,
  AgentTaskTriggerHandler,
} from '@/lib/ai/tasks/triggers'
import { startCoverageSourcingTask } from './agent-task-service'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const COVERAGE_REQUEST_TRIGGER_EVENTS = new Set([
  'coverage.request.approved',
  'coverage.request.activated',
])

export const COVERAGE_SOURCING_TRIGGER_HANDLER: AgentTaskTriggerHandler = {
  domain: 'coverage',
  taskType: 'coverage.sourcing',
  taskTypeVersion: 1,

  validate(definition: AgentTaskTriggerDefinition) {
    if (definition.triggerKind === 'schedule') {
      const requestId = definition.config.coverageRequestId
      if (typeof requestId !== 'string' || !UUID_RE.test(requestId)) {
        throw new Error('COVERAGE_SOURCING_TRIGGER_REQUEST_ID_REQUIRED')
      }
      return
    }

    if (
      !definition.eventType ||
      !COVERAGE_REQUEST_TRIGGER_EVENTS.has(definition.eventType) ||
      definition.eventVersion !== 1
    ) {
      throw new Error('COVERAGE_SOURCING_TRIGGER_EVENT_UNSUPPORTED')
    }

    const subjectType = definition.filters?.subject_type
    if (
      subjectType !== undefined &&
      subjectType !== 'coverage_request'
    ) {
      throw new Error('COVERAGE_SOURCING_TRIGGER_SUBJECT_FILTER_INVALID')
    }
  },

  async start(firing: AgentTaskTriggerFiring) {
    const coverageRequestId =
      firing.triggerKind === 'business_event'
        ? requestIdFromBusinessEvent(firing)
        : requestIdFromConfig(firing.config)

    const result = await startCoverageSourcingTask({
      accountId: firing.accountId,
      coverageRequestId,
      agentId: firing.agentId,
      actorUserId: firing.createdBy,
      trigger: {
        triggerType:
          firing.triggerKind === 'business_event'
            ? 'business_event'
            : 'scheduled',
        triggerRef:
          firing.triggerKind === 'business_event'
            ? 'business_event:' + firing.businessEvent!.id
            : 'schedule:' + firing.triggerId + ':' + firing.sourceKey,
        sourceKey: firing.sourceKey,
      },
    })

    return { taskId: result.taskId }
  },
}

function requestIdFromBusinessEvent(
  firing: AgentTaskTriggerFiring,
): string {
  const event = firing.businessEvent
  if (
    !event ||
    !COVERAGE_REQUEST_TRIGGER_EVENTS.has(event.eventType) ||
    event.eventVersion !== 1 ||
    event.subjectType !== 'coverage_request' ||
    !UUID_RE.test(event.subjectId)
  ) {
    throw new Error('COVERAGE_SOURCING_TRIGGER_EVENT_INVALID')
  }
  return event.subjectId
}

function requestIdFromConfig(
  config: Readonly<Record<string, unknown>>,
): string {
  const requestId = config.coverageRequestId
  if (typeof requestId !== 'string' || !UUID_RE.test(requestId)) {
    throw new Error('COVERAGE_SOURCING_TRIGGER_REQUEST_ID_REQUIRED')
  }
  return requestId
}
