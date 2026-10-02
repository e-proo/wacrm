import type {
  AgentTaskTriggerDefinition,
  AgentTaskTriggerFiring,
  AgentTaskTriggerHandler,
} from '@/lib/ai/tasks/triggers'
import { startServicePromotionTask } from './agent-task-service'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const SERVICE_PROMOTION_TRIGGER_HANDLER: AgentTaskTriggerHandler = {
  domain: 'services',
  taskType: 'services.promotion',
  taskTypeVersion: 1,

  validate(definition: AgentTaskTriggerDefinition) {
    if (definition.triggerKind !== 'schedule') {
      throw new Error('SERVICE_PROMOTION_BUSINESS_EVENT_TRIGGER_UNSUPPORTED')
    }
    const serviceId = definition.config.serviceId
    if (typeof serviceId !== 'string' || !UUID_RE.test(serviceId)) {
      throw new Error('SERVICE_PROMOTION_TRIGGER_SERVICE_ID_REQUIRED')
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

    const result = await startServicePromotionTask({
      accountId: firing.accountId,
      serviceId,
      agentId: firing.agentId,
      actorUserId: firing.createdBy,
      trigger: {
        triggerType: 'scheduled',
        triggerRef: 'schedule:' + firing.triggerId + ':' + firing.sourceKey,
        sourceKey: firing.sourceKey,
      },
    })

    return { taskId: result.taskId }
  },
}
