import type {
  ArgumentSchema,
  ToolDefinition,
} from '@/lib/ai/runtime/tool-registry'
import type { PlatformToolManifest } from './contracts'
import {
  CURRENT_PLATFORM_REGISTRY,
  getCurrentPlatformTool,
} from './current-domain-registry'

const CATEGORY_BY_DOMAIN: Record<
  string,
  ToolDefinition['category']
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
 * Compatibility projection for APIs/UI that still consume the historical
 * ToolDefinition shape. The source of truth is always PlatformToolManifest.
 */
export function platformManifestToToolDefinition(
  manifest: PlatformToolManifest,
): ToolDefinition {
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

export function listCurrentToolDefinitions(): ReadonlyArray<ToolDefinition> {
  return CURRENT_PLATFORM_REGISTRY.listTools().map(platformManifestToToolDefinition)
}

export function getCurrentToolDefinition(
  key: string,
  version?: number,
): ToolDefinition | null {
  const manifest = getCurrentPlatformTool(key, version)
  return manifest ? platformManifestToToolDefinition(manifest) : null
}

function compactArgumentSchema(
  schema: Readonly<Record<string, unknown>>,
): Record<string, ArgumentSchema> {
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
): ArgumentSchema {
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

function isCompactArgumentSchema(value: unknown): value is ArgumentSchema {
  return (
    isRecord(value) &&
    ['string', 'number', 'boolean', 'enum', 'object'].includes(String(value.type))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
