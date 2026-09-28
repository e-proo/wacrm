import { COVERAGE_SOURCING_TASK_MODULE } from '@/lib/services/coverage/agent-task'
import {
  buildAgentTaskPlatform,
  materializeRegisteredTaskTargets,
  type AgentTaskModule,
} from './target-resolution'

/**
 * Single composition root for the Agent Task Platform.
 *
 * Concrete domain modules are registered here in later acceptance phases
 * (Coverage in Phase 11, Services in Phase 12). The kernel remains generic.
 */
export const CURRENT_AGENT_TASK_MODULES: readonly AgentTaskModule[] = [
  COVERAGE_SOURCING_TASK_MODULE,
]

export const CURRENT_AGENT_TASK_PLATFORM = buildAgentTaskPlatform(
  CURRENT_AGENT_TASK_MODULES,
)

export async function materializeCurrentTaskTargets(taskId: string) {
  return materializeRegisteredTaskTargets({
    taskId,
    taskTypes: CURRENT_AGENT_TASK_PLATFORM.taskTypes,
    targetResolvers: CURRENT_AGENT_TASK_PLATFORM.targetResolvers,
  })
}
