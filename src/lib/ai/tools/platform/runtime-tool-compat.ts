import type { ToolGrantPermission } from '@/lib/ai/runtime/multi-agent-types'
import type { PlatformToolManifest } from './contracts'

export interface RuntimeToolArgumentSchema {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'object'
  description: string
  values?: string[]
  required?: boolean
}

export interface RuntimeToolDefinition {
  key: string
  version: number
  description: string
  notes?: string
  argumentSchema: Record<string, RuntimeToolArgumentSchema>
  returnSchema: string
  grantPermissions: ReadonlyArray<ToolGrantPermission>
  category: 'services' | 'pricing' | 'rates' | 'coverage' | 'intents' | 'changes'
  risk: 'read' | 'low' | 'medium' | 'high'
}
import {
  CURRENT_PLATFORM_REGISTRY,
  getCurrentPlatformTool,
} from './current-domain-registry'

const CATEGORY_BY_DOMAIN: Record<
  string,
  RuntimeToolDefinition['category']
> = {
  services: 'services',
  pricing: 'pricing',
  pricing_rules: 'pricing',
  exchange_rates: 'rates',
  coverage: 'coverage',
  intents: 'intents',
  change_requests: 'changes',
}

/**
 * Compatibility projection for APIs/UI that consume the compact runtime tool
 * shape. PlatformToolManifest remains the only source of truth; this module
 * owns only the projection shape and never a second tool registry.
 */
export function platformManifestToToolDefinition(
  manifest: PlatformToolManifest,
): RuntimeToolDefinition {
  return {
    key: manifest.key,
    version: manifest.version,
    description: manifest.description,
    argumentSchema: compactArgumentSchema(manifest.inputSchema),
    returnSchema:
      typeof manifest.outputSchema.description === 'string'
        ? manifest.outputSchema.description
        : JSON.stringify(manifest.outputSchema),
    grantPermissions: [manifest.permission],
    category: CATEGORY_BY_DOMAIN[manifest.domain] ?? 'services',
    risk: manifest.risk === 'critical' ? 'high' : manifest.risk,
  }
}

export function listCurrentToolDefinitions(): ReadonlyArray<RuntimeToolDefinition> {
  return CURRENT_PLATFORM_REGISTRY.listTools().map(platformManifestToToolDefinition)
}

/**
 * Builder-facing projection. Authoritative EXECUTE handlers are platform
 * internals and must never appear as grants an administrator can hand to a
 * model, even if a future native manifest is accidentally projected through
 * this compatibility shape.
 */
export function listBuilderToolDefinitions(): ReadonlyArray<RuntimeToolDefinition> {
  return CURRENT_PLATFORM_REGISTRY
    .listTools()
    .filter(isBuilderExposedManifest)
    .map(platformManifestToToolDefinition)
}

export function getBuilderToolDefinition(
  key: string,
  version?: number,
): RuntimeToolDefinition | null {
  const manifest = getCurrentPlatformTool(key, version)
  return manifest && isBuilderExposedManifest(manifest)
    ? platformManifestToToolDefinition(manifest)
    : null
}

export function getCurrentToolDefinition(
  key: string,
  version?: number,
): RuntimeToolDefinition | null {
  const manifest = getCurrentPlatformTool(key, version)
  return manifest ? platformManifestToToolDefinition(manifest) : null
}

function isBuilderExposedManifest(manifest: PlatformToolManifest): boolean {
  return (
    manifest.modelExposed &&
    !manifest.serverOnly &&
    manifest.permission !== 'execute'
  )
}

function compactArgumentSchema(
  schema: Readonly<Record<string, unknown>>,
): Record<string, RuntimeToolArgumentSchema> {
  if (
    schema.type === 'object' &&
    (schema.properties === undefined || isRecord(schema.properties))
  ) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((value): value is string => typeof value === 'string')
        : [],
    )
    return Object.fromEntries(
      Object.entries(properties).map(([key, raw]) => [
        key,
        jsonPropertyToArgumentSchema(raw, required.has(key)),
      ]),
    )
  }

  return Object.fromEntries(
    Object.entries(schema).map(([key, raw]) => {
      if (!isCompactArgumentSchema(raw)) {
        throw new Error(`Invalid compact tool schema for ${key}`)
      }
      return [key, { ...raw }]
    }),
  )
}

function jsonPropertyToArgumentSchema(
  raw: unknown,
  required: boolean,
): RuntimeToolArgumentSchema {
  if (!isRecord(raw)) {
    return { type: 'object', description: '', required }
  }

  const description =
    typeof raw.description === 'string' ? raw.description : ''

  if (Array.isArray(raw.enum)) {
    return {
      type: 'enum',
      description,
      values: raw.enum.filter((value): value is string => typeof value === 'string'),
      required,
    }
  }

  switch (raw.type) {
    case 'string':
      return { type: 'string', description, required }
    case 'number':
    case 'integer':
      return { type: 'number', description, required }
    case 'boolean':
      return { type: 'boolean', description, required }
    default:
      return { type: 'object', description, required }
  }
}

function isCompactArgumentSchema(value: unknown): value is RuntimeToolArgumentSchema {
  return (
    isRecord(value) &&
    ['string', 'number', 'boolean', 'enum', 'object'].includes(String(value.type))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
