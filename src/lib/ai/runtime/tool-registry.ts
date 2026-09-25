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

const CHANGE_REQUESTS_LIST_PENDING: ToolDefinition = {
  key: 'change_requests.list_pending',
  version: 1,
  description:
    'Admin-only list of pending proposed system changes awaiting a human decision.',
  argumentSchema: {
    limit: {
      type: 'number',
      description: 'Default 20, max 100.',
      required: false,
    },
  },
  returnSchema:
    'Array<{ id, code, target_type, intent, summary, proposed_payload, created_at, expires_at }>',
  grantPermissions: ['read'],
  category: 'changes',
  risk: 'read',
}

// Final transitional registry. Business-domain tools are owned by native
// PlatformToolManifest contracts and projected back to ToolDefinition only via
// runtime-tool-compat for API/UI consumers.
const REGISTRY: ReadonlyArray<ToolDefinition> = [
  CHANGE_REQUESTS_LIST_PENDING,
]

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
