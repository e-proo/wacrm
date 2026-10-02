import type { ToolContext, ToolResult } from '../tools/executors'
import { recordToolAttempt } from './tool-attempt-audit'
import { executeCurrentPlatformTool } from '../tools/platform/current-executor-registry'
import { getCurrentPlatformTool } from '../tools/platform/current-domain-registry'
import { authorizeToolInvocation } from './tool-policy'
import {
  assertRuntimeCircuitClosed,
  recordRuntimeCircuitEvent,
  RuntimeCircuitOpenError,
} from './circuit-breaker'
import type {
  AiAgentRevision,
  ToolGrantPermission,
} from './multi-agent-types'

// Generic runtime tool boundary. Kept separate from inbound/outbound dispatch so
// the single Agent Loop can be reused by every execution mode without importing
// a channel dispatcher.
export interface ToolInvocation {
  toolKey: string
  /** Permission the model claims it needs. Must be 'read' for
   *  every tool Phase 3 ships. */
  permission: ToolGrantPermission
  args: Record<string, unknown>
  /** Round number in the agent's loop, starting at 1. */
  round: number
}

export interface ToolExecutionOutcome {
  toolKey: string
  round: number
  result: ToolResult
  toolFound: boolean
  granted: boolean
  roundsExhausted: boolean
}

export async function executeTool(
  ctx: ToolContext & { revision: AiAgentRevision | null },
  invocation: ToolInvocation,
): Promise<ToolExecutionOutcome> {
  const baseOutcome = {
    toolKey: invocation.toolKey,
    round: invocation.round,
  }

  const audit = async (input: {
    status: 'accepted' | 'denied' | 'succeeded' | 'failed'
    errorCode?: string
    toolVersion?: number
    durationMs?: number
  }) => recordToolAttempt({
    accountId: ctx.accountId,
    runId: ctx.runId,
    agentId: ctx.agentId ?? null,
    revisionId: ctx.revisionId ?? ctx.revision?.id ?? null,
    toolKey: invocation.toolKey,
    toolVersion: input.toolVersion ?? 1,
    round: invocation.round,
    permission: invocation.permission,
    status: input.status,
    errorCode: input.errorCode,
    args: invocation.args,
    durationMs: input.durationMs,
  })

  // Tool-round cap is enforced from the revision (maxToolRounds).
  const maxRounds = ctx.revision?.maxToolRounds ?? 0
  if (maxRounds === 0) {
    await audit({ status: 'denied', errorCode: 'TOOL_ROUNDS_DISABLED' })
    return {
      ...baseOutcome,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'TOOL_ROUNDS_DISABLED',
        message:
          'This agent does not have tool rounds enabled. Reschedule or ask a human.',
      },
      toolFound: false,
      granted: false,
      roundsExhausted: true,
    }
  }
  if (invocation.round > maxRounds) {
    await audit({ status: 'denied', errorCode: 'TOOL_ROUNDS_EXHAUSTED' })
    return {
      ...baseOutcome,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'TOOL_ROUNDS_EXHAUSTED',
        message: 'Tool rounds exhausted.',
      },
      toolFound: false,
      granted: false,
      roundsExhausted: true,
    }
  }

  const latestTool = getCurrentPlatformTool(invocation.toolKey)
  if (!latestTool) {
    await audit({ status: 'denied', errorCode: 'UNKNOWN_TOOL' })
    return {
      ...baseOutcome,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'UNKNOWN_TOOL',
        message: `Tool "${invocation.toolKey}" is not registered.`,
      },
      toolFound: false,
      granted: false,
      roundsExhausted: false,
    }
  }

  // DENY BY DEFAULT — the RUNNING REVISION must carry a grant for
  // this exact tool and exact frozen version. A newer registered version must
  // not invalidate a still-registered historical grant.
  const grantedLvl = ctx.grants?.[invocation.toolKey]
  if (!grantedLvl) {
    await audit({
      status: 'denied',
      errorCode: 'TOOL_NOT_GRANTED',
      toolVersion: latestTool.version,
    })
    return {
      ...baseOutcome,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'TOOL_NOT_GRANTED',
        message: `Tool "${invocation.toolKey}" is not part of this assistant's capabilities.`,
      },
      toolFound: true,
      granted: false,
      roundsExhausted: false,
    }
  }

  const grantedVersion = ctx.grantVersions?.[invocation.toolKey]
  const tool =
    grantedVersion == null
      ? null
      : getCurrentPlatformTool(invocation.toolKey, grantedVersion)
  if (!tool) {
    await audit({
      status: 'denied',
      errorCode: 'TOOL_VERSION_MISMATCH',
      toolVersion: grantedVersion ?? latestTool.version,
    })
    return {
      ...baseOutcome,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'TOOL_VERSION_MISMATCH',
        message: `Tool "${invocation.toolKey}" grant is stale.`,
      },
      toolFound: true,
      granted: false,
      roundsExhausted: false,
    }
  }

  const RANK: Record<ToolGrantPermission, number> = {
    read: 1,
    propose: 2,
    execute: 3,
  }
  if (RANK[invocation.permission] > RANK[grantedLvl]) {
    await audit({
      status: 'denied',
      errorCode: 'TOOL_GRANT_LEVEL_DENIED',
      toolVersion: tool.version,
    })
    return {
      ...baseOutcome,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'TOOL_GRANT_LEVEL_DENIED',
        message: `Tool "${invocation.toolKey}" is granted at level "${grantedLvl}", not "${invocation.permission}".`,
      },
      toolFound: true,
      granted: false,
      roundsExhausted: false,
    }
  }

  if (tool.permission !== invocation.permission) {
    await audit({
      status: 'denied',
      errorCode: 'TOOL_PERMISSION_DENIED',
      toolVersion: latestTool.version,
    })
    return {
      ...baseOutcome,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'TOOL_PERMISSION_DENIED',
        message: `Tool "${invocation.toolKey}" cannot be used with permission "${invocation.permission}".`,
      },
      toolFound: true,
      granted: false,
      roundsExhausted: false,
    }
  }

  const policy = authorizeToolInvocation({
    tool,
    permission: invocation.permission,
    args: invocation.args,
    constraints: ctx.grantConstraints?.[invocation.toolKey] ?? {},
    context: {
      plane: ctx.plane,
      channel: ctx.channel,
      simulation: ctx.simulation,
      agentPurpose: ctx.agentPurpose,
      trustedAdminIdentityId: ctx.trustedAdminIdentityId,
      trustedAdminCapabilities: ctx.trustedAdminCapabilities,
      agentCapabilities: ctx.agentCapabilities ?? [],
      taskAllowedTools: ctx.taskAllowedTools ?? null,
      features: ctx.features,
    },
  })
  if (!policy.ok) {
    await audit({ status: 'denied', errorCode: policy.code, toolVersion: tool.version })
    return {
      ...baseOutcome,
      result: {
        ok: false,
        data: null,
        safe_to_show: true,
        code: policy.code,
        message: policy.message,
      },
      toolFound: true,
      granted: false,
      roundsExhausted: false,
    }
  }

  const toolCircuitKey = tool.key + '@' + tool.version
  try {
    await assertRuntimeCircuitClosed({
      accountId: ctx.accountId,
      scopeType: 'tool',
      scopeKey: toolCircuitKey,
    })
  } catch (error) {
    if (error instanceof RuntimeCircuitOpenError) {
      await audit({
        status: 'denied',
        errorCode: error.code,
        toolVersion: tool.version,
      })
      return {
        ...baseOutcome,
        result: {
          ok: false,
          data: null,
          safe_to_show: true,
          code: error.code,
          message: 'This tool is temporarily paused after repeated failures.',
        },
        toolFound: true,
        granted: true,
        roundsExhausted: false,
      }
    }
    throw error
  }

  const startedAt = Date.now()
  let result: ToolResult
  try {
    result = await executeCurrentPlatformTool(ctx, tool, invocation.args)
  } catch (err) {
    console.error(
      `[ai dispatch] tool ${invocation.toolKey} crashed:`,
      err,
    )
    result = {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'TOOL_INTERNAL_ERROR',
      message: 'Tool execution failed unexpectedly.',
    }
  }

  await audit({
    status: result.ok ? 'succeeded' : 'failed',
    errorCode: result.ok ? undefined : result.code,
    toolVersion: tool.version,
    durationMs: Date.now() - startedAt,
  })

  if (result.ok || result.safe_to_show === false) {
    await recordRuntimeCircuitEvent({
      accountId: ctx.accountId,
      scopeType: 'tool',
      scopeKey: toolCircuitKey,
      outcome: result.ok ? 'success' : 'failure',
      errorCode: result.ok ? null : result.code,
    })
  }
  return {
    ...baseOutcome,
    result,
    toolFound: true,
    granted: true,
    roundsExhausted: false,
  }
}

