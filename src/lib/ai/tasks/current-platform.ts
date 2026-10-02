import { COVERAGE_SOURCING_TASK_MODULE } from '@/lib/services/coverage/agent-task'
import { COVERAGE_SOURCING_TRIGGER_HANDLER } from '@/lib/services/coverage/agent-task-trigger'
import { SERVICE_PROMOTION_TASK_MODULE } from '@/lib/services/service-catalog/agent-task'
import { SERVICE_PROMOTION_TRIGGER_HANDLER } from '@/lib/services/service-catalog/agent-task-trigger'
import {
  buildAgentTaskPlatform,
  materializeRegisteredTaskTargets,
  type AgentTaskModule,
} from './target-resolution'
import { evaluateRegisteredTaskCompletion } from './completion-policy'
import {
  buildAgentTaskTriggerRegistry,
  createRegisteredAgentTaskTrigger,
  type AgentTaskTriggerDefinition,
} from './triggers'

/**
 * Single composition root for the Agent Task Platform.
 *
 * Concrete domain modules are registered here in later acceptance phases
 * (Coverage in Phase 11, Services in Phase 12). The kernel remains generic.
 */
export const CURRENT_AGENT_TASK_MODULES: readonly AgentTaskModule[] = [
  COVERAGE_SOURCING_TASK_MODULE,
  SERVICE_PROMOTION_TASK_MODULE,
]

export const CURRENT_AGENT_TASK_PLATFORM = buildAgentTaskPlatform(
  CURRENT_AGENT_TASK_MODULES,
)

export const CURRENT_AGENT_TASK_TRIGGER_REGISTRY =
  buildAgentTaskTriggerRegistry([
    COVERAGE_SOURCING_TRIGGER_HANDLER,
    SERVICE_PROMOTION_TRIGGER_HANDLER,
  ])

for (const handler of CURRENT_AGENT_TASK_TRIGGER_REGISTRY.list()) {
  const manifest = CURRENT_AGENT_TASK_PLATFORM.taskTypes.get(
    handler.taskType,
    handler.taskTypeVersion,
  )
  if (!manifest || manifest.domain !== handler.domain) {
    throw new Error(
      'AGENT_TASK_TRIGGER_HANDLER_TASK_TYPE_NOT_REGISTERED:' +
        handler.taskType +
        '@' +
        handler.taskTypeVersion,
    )
  }
}

export async function createCurrentAgentTaskTrigger(
  definition: AgentTaskTriggerDefinition,
) {
  return createRegisteredAgentTaskTrigger({
    registry: CURRENT_AGENT_TASK_TRIGGER_REGISTRY,
    definition,
  })
}

export async function materializeCurrentTaskTargets(taskId: string) {
  return materializeRegisteredTaskTargets({
    taskId,
    taskTypes: CURRENT_AGENT_TASK_PLATFORM.taskTypes,
    targetResolvers: CURRENT_AGENT_TASK_PLATFORM.targetResolvers,
  })
}


export async function evaluateCurrentTaskCompletion(taskId: string) {
  const { supabaseAdmin } = await import('../admin-client')
  return evaluateRegisteredTaskCompletion({
    db: supabaseAdmin(),
    taskId,
    taskTypes: CURRENT_AGENT_TASK_PLATFORM.taskTypes,
    completionPolicies: CURRENT_AGENT_TASK_PLATFORM.completionPolicies,
  })
}
