import { NextResponse } from 'next/server'
import { requireAgentCapability, toErrorResponse } from '@/lib/auth/account'
import { CURRENT_AGENT_TASK_PLATFORM } from '@/lib/ai/tasks/current-platform'

const TARGET_SCOPE_KINDS = [
  'segments',
  'tags',
  'service_relationship',
  'regions',
  'predefined_filter',
  'domain_selector',
] as const

function manifests() {
  return CURRENT_AGENT_TASK_PLATFORM.taskTypes.list().map((manifest) => ({
    key: manifest.key,
    version: manifest.version,
    domain: manifest.domain,
    title: manifest.title,
    description: manifest.description,
    requiredAgentCapabilities: manifest.requiredAgentCapabilities,
    allowedChannels: manifest.allowedChannels,
    requiredTaskApproval: manifest.requiredTaskApproval,
    maxTargets: manifest.maxTargets,
    followupPolicy: manifest.followupPolicy,
    allowedTools: manifest.allowedTools,
  }))
}

export async function GET() {
  try {
    await requireAgentCapability('agents.read')
    return NextResponse.json({
      taskTypes: manifests(),
      targetScopeKinds: TARGET_SCOPE_KINDS,
      approvalModes: ['none', 'task', 'batch'],
      operationalModes: ['reactive', 'outbound', 'both'],
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * Builder dry-run preview. This endpoint is intentionally side-effect free:
 * it does not create tasks/targets/runs, reserve outbound effects, or call
 * WhatsApp. Domain target resolution remains owned by an actual Task dry-run.
 */
export async function POST(request: Request) {
  try {
    await requireAgentCapability('agents.read')
    const body = (await request.json().catch(() => ({}))) as {
      taskTypes?: Array<{ key?: string; version?: number }>
      maxTargets?: number
    }
    const registry = CURRENT_AGENT_TASK_PLATFORM.taskTypes
    const selected = (body.taskTypes ?? []).map((item) => {
      const key = String(item.key ?? '')
      const version = Number(item.version ?? 0)
      const manifest = registry.get(key, version)
      return manifest
        ? {
            key: manifest.key,
            version: manifest.version,
            title: manifest.title,
            tools: manifest.allowedTools,
            maxTargets: manifest.maxTargets,
          }
        : { key, version, unavailable: true as const }
    })
    const warnings = selected
      .filter((item) => 'unavailable' in item)
      .map((item) => `Task Type ${item.key}@${item.version} is not registered.`)

    return NextResponse.json({
      dryRun: true,
      sideEffects: false,
      selectedTargets: [],
      skippedTargets: [],
      skippedReasons: [],
      sampleGeneratedMessages: [],
      toolsCalled: [],
      estimatedCost: null,
      estimatedSendCount: 0,
      selectedTaskTypes: selected,
      requestedMaxTargets: Number.isFinite(body.maxTargets) ? body.maxTargets : null,
      policyWarnings: warnings,
      note: 'Target selection and message generation require a concrete Task dry-run; this Builder preview never sends or mutates business data.',
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
