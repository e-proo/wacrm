import {
  type ToolContext,
  type ToolResult,
} from '../executors'
import { executeChangeRequestsListPending } from '../business-handoff'
import type { PlatformToolManifest } from './contracts'
import { CURRENT_BUSINESS_DOMAIN_RUNTIMES } from '@/lib/services/platform/composition'
import { ToolExecutorRegistry } from './execution-registry'
import { getCurrentPlatformTool } from './current-domain-registry'
import type { ModelToolRuntimeExecutor } from './runtime-contracts'

type RuntimeResult = ToolResult<unknown>
type RuntimeExecutor = ModelToolRuntimeExecutor

const CURRENT_EXECUTORS = new ToolExecutorRegistry<ToolContext, RuntimeResult>()

function add(key: string, version: number, executor: RuntimeExecutor): void {
  const contract = getCurrentPlatformTool(key, version)
  if (!contract) throw new Error(`Cannot register executor without platform contract: ${key}@${version}`)
  CURRENT_EXECUTORS.register({ key, version, executor })
}

/**
 * Transitional registrations for domains that have not yet moved into a
 * BusinessDomainRuntime. FX V2, Coverage, and Intents are registered below
 * from their owning domain runtimes.
 */
add('change_requests.list_pending', 1, (ctx, args) => executeChangeRequestsListPending(ctx, args as never))

for (const runtime of CURRENT_BUSINESS_DOMAIN_RUNTIMES) {
  for (const registration of runtime.toolExecutors) {
    add(registration.key, registration.version, registration.executor)
  }
}

const MODEL_SECRET_KEYS = new Set([
  'confirmation_code',
  'confirmationCode',
  'confirmation_code_hash',
  'confirmationCodeHash',
])

function stripModelSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripModelSecrets)
  if (!value || typeof value !== 'object') return value

  const clean: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (MODEL_SECRET_KEYS.has(key)) continue
    clean[key] = stripModelSecrets(child)
  }
  return clean
}

export function sanitizeToolResultForModel(result: RuntimeResult): RuntimeResult {
  if (result.data == null) return result
  return { ...result, data: stripModelSecrets(result.data) }
}

export async function executeCurrentPlatformTool(
  ctx: ToolContext,
  tool: PlatformToolManifest,
  args: Record<string, unknown>,
): Promise<RuntimeResult> {
  const contract = getCurrentPlatformTool(tool.key, tool.version)
  if (!contract) {
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'TOOL_CONTRACT_MISSING',
      message: 'Tool is not available.',
    }
  }
  if (!CURRENT_EXECUTORS.has(tool.key, tool.version)) {
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'TOOL_EXECUTOR_MISSING',
      message: 'Tool is not available.',
    }
  }
  const result = await CURRENT_EXECUTORS.execute(tool.key, tool.version, ctx, args)
  return sanitizeToolResultForModel(result)
}
