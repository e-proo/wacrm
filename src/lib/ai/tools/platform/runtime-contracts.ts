import type { ToolContext, ToolResult } from '../executors'

export type ModelToolRuntimeResult = ToolResult<unknown>

export type ModelToolRuntimeExecutor = (
  ctx: ToolContext,
  args: Record<string, unknown>,
) => Promise<ModelToolRuntimeResult>

export interface ModelToolExecutorRegistration {
  key: string
  version: number
  executor: ModelToolRuntimeExecutor
}
