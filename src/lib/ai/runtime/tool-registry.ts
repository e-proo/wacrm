// ============================================================
// Tool registry — Phase 1 skeleton.
//
// Phase 1 ships ZERO executable tools (no `propose_*`, no
// `services.search`). The registry exists so:
//   • the DB grants table can be validated at publish time,
//   • Phase 3 (tool calls + change-request approvals) can plug in
//     by adding entries without changing call sites,
//   • the runtime can compute an "effective grant" (registry ∩
//     revision grants ∩ policy) before each call.
//
// DENY BY DEFAULT: anything not registered here is refused.
// ============================================================

import type { ToolGrantPermission } from './multi-agent-types'

/** A tool's effect on the system. `execute-internal` is NEVER
 *  exposed to the model — only the approval engine can call it. */
export type ToolEffect = 'read' | 'propose' | 'execute-internal'

export interface ToolDefinition {
  /** Stable key, e.g. `services.search`. Phase 1 has none. */
  key: string
  /** Schema version. Bumped when input/output shape changes. */
  version: number
  /** Short description surfaced to the model (no secrets). */
  description: string
  /** Required capabilities the actor must hold. */
  requiredCapabilities: ReadonlyArray<string>
  /** Effect of calling this tool. */
  effect: ToolEffect
  /** Permitted `permission` values in `ai_agent_tool_grants`. */
  grantPermissions: ReadonlyArray<ToolGrantPermission>
  /** Risk classifier — drives the approval flow's UX. */
  risk: 'read' | 'low' | 'medium' | 'high'
}

/**
 * The closed registry. Phase 1 entries are intentionally empty so
 * any code that tries to resolve a tool key gets a clean
 * `unknown_tool` error. Phase 3 will register `services.search`,
 * `pricing.calculate_quote`, etc.
 */
const REGISTRY: ReadonlyArray<ToolDefinition> = []

export function listRegisteredTools(): ReadonlyArray<ToolDefinition> {
  return REGISTRY
}

export function getRegisteredTool(key: string): ToolDefinition | null {
  return REGISTRY.find((t) => t.key === key) ?? null
}

export function isGrantAllowed(
  tool: ToolDefinition,
  permission: ToolGrantPermission,
): boolean {
  return tool.grantPermissions.includes(permission)
}
