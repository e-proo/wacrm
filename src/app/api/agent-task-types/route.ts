import { NextResponse } from 'next/server'
import { requireAgentCapability, toErrorResponse } from '@/lib/auth/account'
import { CURRENT_AGENT_TASK_PLATFORM } from '@/lib/ai/tasks/current-platform'
import {
  defaultBuilderTaskBinding,
  isAgentBuilderV2Configuration,
  listBuilderTaskTypes,
  validateBuilderV2Configuration,
} from '@/lib/ai/tasks/builder-v2'

function catalog() {
  return listBuilderTaskTypes(CURRENT_AGENT_TASK_PLATFORM.taskTypes).map(
    (taskType) => {
      const manifest = CURRENT_AGENT_TASK_PLATFORM.taskTypes.get(
        taskType.key,
        taskType.version,
      )
      return {
        ...taskType,
        defaultBinding: manifest
          ? defaultBuilderTaskBinding(manifest)
          : null,
      }
    },
  )
}

export async function GET() {
  try {
    await requireAgentCapability('agents.read')
    return NextResponse.json({ taskTypes: catalog() })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * Builder dry-run preview. This endpoint is deliberately side-effect free.
 * It validates the exact registered Task Type bindings and returns deterministic
 * upper-bound estimates, but it never materializes targets, creates Agent Runs,
 * reserves outbound effects, mutates business data, or sends WhatsApp.
 *
 * Concrete selected/skipped targets and generated message samples become
 * available only when a domain Task Type supplies its deterministic resolver
 * and simulation runtime (Coverage in Phase 11, Services in Phase 12).
 */
export async function POST(request: Request) {
  try {
    await requireAgentCapability('agents.read')
    const body = await request.json().catch(() => null)
    if (!isAgentBuilderV2Configuration(body)) {
      return NextResponse.json(
        {
          error: 'Builder V2 configuration has an invalid shape.',
          code: 'INVALID_BUILDER_V2_CONFIGURATION',
        },
        { status: 400 },
      )
    }

    const validation = validateBuilderV2Configuration({
      config: body,
      registry: CURRENT_AGENT_TASK_PLATFORM.taskTypes,
      revisionToolGrants: [],
    })

    const selectedTaskTypes = body.bindings.map((binding) => {
      const manifest = CURRENT_AGENT_TASK_PLATFORM.taskTypes.get(
        binding.taskType,
        binding.taskTypeVersion,
      )
      return {
        key: binding.taskType,
        version: binding.taskTypeVersion,
        title: manifest?.title ?? binding.taskType,
        maxTargets: binding.maxTargets,
        maxFollowups: binding.maxFollowups,
        allowedTools: manifest?.allowedTools ?? [],
      }
    })

    const estimatedSendCount = body.bindings.reduce(
      (total, binding) =>
        total + binding.maxTargets * (1 + binding.maxFollowups),
      0,
    )

    return NextResponse.json({
      dryRun: true,
      sideEffects: false,
      validation: {
        ok: validation.ok,
        issues: validation.issues,
      },
      selectedTaskTypes,
      selectedTargets: [],
      skippedTargets: [],
      skippedReasons: [],
      sampleGeneratedMessages: [],
      toolsCalled: [],
      estimatedCost: null,
      estimatedSendCount,
      policyWarnings: validation.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: issue.path,
      })),
      note:
        'This Builder preview performs no target resolution or message generation. Domain simulations add those details without sending or mutating business data.',
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
