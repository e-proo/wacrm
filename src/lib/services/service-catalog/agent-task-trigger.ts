import type {
  AgentTaskTriggerDefinition,
  AgentTaskTriggerFiring,
  AgentTaskTriggerHandler,
} from '@/lib/ai/tasks/triggers'
import { startServicePromotionTask } from './agent-task-service'
import { readFrozenPromotionSchedule } from './promotion-schedule-policy'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const SERVICE_PROMOTION_TRIGGER_HANDLER_V2: AgentTaskTriggerHandler = {
  domain: 'services',
  taskType: 'services.promotion',
  taskTypeVersion: 2,

  validate(definition: AgentTaskTriggerDefinition) {
    if (definition.triggerKind !== 'schedule') {
      throw new Error('SERVICE_PROMOTION_BUSINESS_EVENT_TRIGGER_UNSUPPORTED')
    }
    const serviceId = definition.config.serviceId
    if (typeof serviceId !== 'string' || !UUID_RE.test(serviceId)) {
      throw new Error('SERVICE_PROMOTION_TRIGGER_SERVICE_ID_REQUIRED')
    }
    // Only a reviewed server-frozen campaign can be scheduled, never arbitrary
    // serviceId lists or implicit contacts.
    if (!definition.config.promotionReview ||
      !definition.config.connectionId) {
      throw new Error('SERVICE_PROMOTION_SCHEDULE_REVIEW_REQUIRED')
    }
  },

  async start(firing: AgentTaskTriggerFiring) {
    if (firing.triggerKind !== 'schedule') {
      throw new Error('SERVICE_PROMOTION_BUSINESS_EVENT_TRIGGER_UNSUPPORTED')
    }

    const serviceId = firing.config.serviceId
    if (typeof serviceId !== 'string' || !UUID_RE.test(serviceId)) {
      throw new Error('SERVICE_PROMOTION_TRIGGER_SERVICE_ID_REQUIRED')
    }

    const reviewed = readFrozenPromotionSchedule(firing.config, {
      serviceId, agentId: firing.agentId,
      approvedRevisionId: firing.approvedRevisionId, createdBy: firing.createdBy,
    })
    if (firing.config.scheduleKind === 'recurring' && !reviewed.recurringAcknowledged) {
      throw new Error('SERVICE_PROMOTION_RECURRING_APPROVAL_REQUIRED')
    }
    const result = await startServicePromotionTask({
      accountId: firing.accountId,
      serviceId,
      agentId: firing.agentId,
      actorUserId: firing.createdBy,
      approvedRevisionId: firing.approvedRevisionId,
      review: {
        connectionId: reviewed.connectionId,
        fingerprint: reviewed.fingerprint,
        reviewedAt: reviewed.reviewedAt,
        submissionId: firing.firingId,
        consentAcknowledged: true,
        approvalAcknowledged: true,
        scheduledPolicy: reviewed,
      },
      trigger: {
        triggerType: 'scheduled',
        triggerRef: 'schedule:' + firing.triggerId + ':' + firing.sourceKey,
        sourceKey: firing.sourceKey,
      },
    })

    return { taskId: result.taskId, created: result.created }
  },
}

/** Historical V1 policies cannot bypass the V2 reviewed campaign boundary. */
export const SERVICE_PROMOTION_TRIGGER_HANDLER: AgentTaskTriggerHandler = {
  ...SERVICE_PROMOTION_TRIGGER_HANDLER_V2,
  taskTypeVersion: 1,
  validate() { throw new Error('SERVICE_PROMOTION_V1_SCHEDULING_DISABLED') },
  async start() { throw new Error('SERVICE_PROMOTION_V1_SCHEDULING_DISABLED') },
}
