import {
  assertValidToolManifest,
  type PlatformToolManifest,
} from '@/lib/ai/tools/platform/contracts'
import { STANDARD_PLATFORM_TOOL_ERRORS } from '@/lib/services/platform/tool-contract-defaults'

export const AGENT_TASK_TARGET_OUTCOMES = [
  'declined',
  'unavailable',
] as const

export type AgentTaskTargetOutcome =
  (typeof AGENT_TASK_TARGET_OUTCOMES)[number]

export interface AgentTaskTargetOutcomeObservation {
  outcome: AgentTaskTargetOutcome
  detail: string | null
}

/**
 * Provider-facing runtime observation tool.
 *
 * It is deliberately NOT registered in the Platform Tool Registry and does
 * not mutate data. It only lets the model report a bounded semantic
 * observation about the already-bound current Task Target. The server later
 * validates the run/target identity and performs any lifecycle transition.
 *
 * Consequently the model never receives task_id/target_id parameters and
 * cannot use this signal to widen scope or mutate an arbitrary target.
 */
export const AGENT_TASK_TARGET_OUTCOME_OBSERVATION_TOOL: PlatformToolManifest =
  assertValidToolManifest({
    key: 'agent_tasks.report_target_outcome',
    version: 1,
    domain: 'agent_tasks',
    title: 'Report current task-target outcome',
    description:
      'Report only a clear supplier decline or explicit temporary/unavailable response for the current server-bound task target. This observation itself performs no write.',
    purpose:
      'Capture an explicit terminal supplier response without allowing the model to select or mutate another task target.',
    whenToUse: [
      'The current supplier explicitly declines the sourcing request.',
      'The current supplier explicitly says they are unavailable or cannot supply it.',
    ],
    whenNotToUse: [
      'Do not use while the supplier is negotiating, asking questions, giving a valid offer, or when the meaning is ambiguous.',
      'Do not use to mark another contact or target; the runtime binds this observation to the current target.',
    ],
    inputSchema: {
      outcome: {
        type: 'enum',
        description: 'Observed terminal response for this current target only.',
        values: [...AGENT_TASK_TARGET_OUTCOMES],
        required: true,
      },
      detail: {
        type: 'string',
        description:
          'Optional short factual reason from the supplier response. Do not add hidden reasoning.',
        required: false,
      },
    },
    outputSchema: {
      description:
        '{ accepted: true, outcome } when the bounded observation was recorded in the current model turn.',
    },
    permission: 'read',
    risk: 'low',
    allowedPlanes: ['customer'],
    requiredCapabilities: [],
    supportedGrantConstraints: [],
    sideEffect: 'none',
    approvalRequired: false,
    idempotent: true,
    audit: 'invocation',
    modelExposed: true,
    serverOnly: false,
    examples: [],
    errorContract: STANDARD_PLATFORM_TOOL_ERRORS,
  })

export function parseAgentTaskTargetOutcomeObservation(
  raw: Record<string, unknown>,
): AgentTaskTargetOutcomeObservation | null {
  const outcome = raw.outcome
  if (
    typeof outcome !== 'string' ||
    !(AGENT_TASK_TARGET_OUTCOMES as readonly string[]).includes(outcome)
  ) {
    return null
  }

  const detailRaw = raw.detail
  if (
    detailRaw !== undefined &&
    detailRaw !== null &&
    typeof detailRaw !== 'string'
  ) {
    return null
  }

  const detail =
    typeof detailRaw === 'string' && detailRaw.trim()
      ? detailRaw.trim().slice(0, 500)
      : null

  return {
    outcome: outcome as AgentTaskTargetOutcome,
    detail,
  }
}
