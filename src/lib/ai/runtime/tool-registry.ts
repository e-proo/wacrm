import type { ToolGrantPermission } from './multi-agent-types'

export type ToolEffect = 'read' | 'propose' | 'execute-internal'

export interface ToolDefinition {
  key: string
  version: number
  description: string
  notes?: string
  argumentSchema: Record<string, ArgumentSchema>
  returnSchema: string
  grantPermissions: ReadonlyArray<ToolGrantPermission>
  category: 'services' | 'pricing' | 'rates' | 'coverage' | 'intents' | 'changes'
  risk: 'read' | 'low' | 'medium' | 'high'
}

export interface ArgumentSchema {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'object'
  description: string
  values?: string[]
  required?: boolean
}

// Historical compatibility registry. All current tools are now owned by
// native PlatformToolManifest contracts under business domains. Keep these
// helpers temporarily so older internal callers fail closed while Phase 5
// contracts the remaining compatibility surface.
const REGISTRY: ReadonlyArray<ToolDefinition> = []

export function listRegisteredTools(): ReadonlyArray<ToolDefinition> {
  return REGISTRY
}

export function getRegisteredTool(key: string): ToolDefinition | null {
  return REGISTRY.find((tool) => tool.key === key) ?? null
}

export function isGrantAllowed(
  tool: ToolDefinition,
  permission: ToolGrantPermission,
): boolean {
  return tool.grantPermissions.includes(permission)
}

export function renderToolCatalog(
  grants: ReadonlyArray<{
    tool_key: string
    permission: ToolGrantPermission
  }>,
): string {
  const lines: string[] = []
  for (const grant of grants) {
    const tool = getRegisteredTool(grant.tool_key)
    if (!tool) continue
    const args = Object.entries(tool.argumentSchema).map(
      ([name, schema]) =>
        `${name}${schema.required === false ? '?' : ''}: ${schema.type === 'enum' ? (schema.values ?? ['string']).join('|') : schema.type}`,
    )
    lines.push(
      `- ${tool.key} (${grant.permission}): ${tool.description}` +
        (args.length > 0 ? ` | args: {${args.join(', ')}}` : ''),
    )
  }
  return lines.join('\n')
}
