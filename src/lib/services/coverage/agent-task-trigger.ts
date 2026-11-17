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

function buildCoverageSourcingTriggerHandler(version: 1 | 2): AgentTaskTriggerHandler {
  return {
  domain: 'coverage',
  taskType: 'coverage.sourcing',
  taskTypeVersion: version,

  validate(definition: AgentTaskTriggerDefinition) {
    if (definition.triggerKind === 'schedule') {
      const requestId = definition.config.coverageRequestId
      if (typeof requestId !== 'string' || !UUID_RE.test(requestId)) {
        throw new Error('COVERAGE_SOURCING_TRIGGER_REQUEST_ID_REQUIRED')
      }
      if (version === 2 && !UUID_RE.test(String(definition.config.whatsappConnectionId ?? ''))) {
        throw new Error('COVERAGE_SOURCING_TRIGGER_CONNECTION_REQUIRED')
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
      subjectType !== 'coverage_request' ||
      !UUID_RE.test(String(definition.filters?.subject_id ?? '')) ||
      definition.filters?.subject_id !== definition.config.coverageRequestId
    ) {
      throw new Error('COVERAGE_SOURCING_TRIGGER_SUBJECT_FILTER_INVALID')
    }
    if (version === 2 && !UUID_RE.test(String(definition.config.whatsappConnectionId ?? ''))) {
      throw new Error('COVERAGE_SOURCING_TRIGGER_CONNECTION_REQUIRED')
    }
  },

  async start(firing: AgentTaskTriggerFiring) {
    const coverageRequestId =
      firing.triggerKind === 'business_event'
        ? requestIdFromBusinessEvent(firing)
        : requestIdFromConfig(firing.config)

    const pinnedConnection = firing.config.whatsappConnectionId
    if (version === 2 && !UUID_RE.test(String(pinnedConnection ?? ''))) {
      throw new Error('COVERAGE_SOURCING_SCHEDULE_CONNECTION_REQUIRED')
    }
    const contacts = firing.config.selectedContactIds
    if (version === 2 && (
      !Array.isArray(contacts) || contacts.length < 1 || contacts.length > 20 ||
      !contacts.every(id => typeof id === 'string' && UUID_RE.test(id)) ||
      new Set(contacts).size !== contacts.length
    )) {
      throw new Error('COVERAGE_SOURCING_SCHEDULE_CONTACTS_INVALID')
    }
    const result = await startCoverageSourcingTask({
      accountId: firing.accountId,
      coverageRequestId,
      agentId: firing.agentId,
      actorUserId: firing.createdBy,
      approvedRevisionId: firing.approvedRevisionId,
      whatsappConnectionId: version === 2 ? pinnedConnection as string : null,
      selectedContactIds: version === 2 ? contacts as string[] : null,
      requestedTaskTypeVersion: version,
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

    return { taskId: result.taskId, created: result.created }
  },
  }
}

export const COVERAGE_SOURCING_TRIGGER_HANDLER = buildCoverageSourcingTriggerHandler(1)
export const COVERAGE_SOURCING_TRIGGER_HANDLER_V2 = buildCoverageSourcingTriggerHandler(2)

function requestIdFromBusinessEvent(
  firing: AgentTaskTriggerFiring,
): string {
  const event = firing.businessEvent
  if (
    !event ||
    !COVERAGE_REQUEST_TRIGGER_EVENTS.has(event.eventType) ||
    event.eventVersion !== 1 ||
    event.subjectType !== 'coverage_request' ||
    !UUID_RE.test(event.subjectId) ||
    firing.config.coverageRequestId !== event.subjectId ||
    firing.filters.subject_type !== 'coverage_request' ||
    firing.filters.subject_id !== event.subjectId ||
    (typeof event.payload.account_id === 'string' &&
      event.payload.account_id !== firing.accountId)
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
