import type { PlatformToolManifest } from '@/lib/ai/tools/platform/contracts'

export interface ToolArgumentValidation {
  ok: boolean
  value: Record<string, unknown> | null
  error?: string
}

interface ArgumentSchema {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'object'
  description?: string
  values?: readonly string[]
  required?: boolean
}

/**
 * Platform manifests support the historical compact argument-map shape during
 * the strangler transition, while also allowing a full root JSON Schema for
 * future domains. Provider payloads and runtime validation both use this same
 * canonical manifest source.
 */
export function toJsonSchema(
  tool: Pick<PlatformToolManifest, 'inputSchema'>,
): Record<string, unknown> {
  const root = tool.inputSchema
  if (isRootJsonSchema(root)) return { ...root }

  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, raw] of Object.entries(root)) {
    const def = asArgumentSchema(raw)
    if (!def) throw new Error(`Invalid platform tool argument schema: ${name}`)
    properties[name] = argumentToJsonSchema(def)
    if (def.required !== false) required.push(name)
  }
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  }
}

function argumentToJsonSchema(def: ArgumentSchema): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ...(def.description ? { description: def.description } : {}),
  }
  switch (def.type) {
    case 'string':
      return { ...base, type: 'string' }
    case 'number':
      return { ...base, type: 'number' }
    case 'boolean':
      return { ...base, type: 'boolean' }
    case 'enum':
      return { ...base, type: 'string', enum: [...(def.values ?? [])] }
    case 'object':
      return { ...base, type: 'object' }
  }
}

/**
 * Strict top-level validator used even when a provider claims to support
 * strict schemas. Provider output is always untrusted.
 */
export function validateToolArguments(
  tool: Pick<PlatformToolManifest, 'inputSchema'>,
  args: unknown,
): ToolArgumentValidation {
  if (!isRecord(args)) {
    return { ok: false, value: null, error: 'arguments must be an object' }
  }

  const root = tool.inputSchema
  if (isRootJsonSchema(root)) {
    return validateRootJsonSchema(root, args)
  }

  const known = new Set(Object.keys(root))
  for (const key of Object.keys(args)) {
    if (!known.has(key)) {
      return { ok: false, value: null, error: `unknown argument: ${key}` }
    }
  }

  for (const [key, raw] of Object.entries(root)) {
    const def = asArgumentSchema(raw)
    if (!def) {
      return { ok: false, value: null, error: `invalid schema: ${key}` }
    }
    const value = args[key]
    if (value === undefined || value === null) {
      if (def.required !== false) {
        return { ok: false, value: null, error: `missing argument: ${key}` }
      }
      continue
    }
    if (!matchesCompactType(def, value)) {
      return {
        ok: false,
        value: null,
        error: `invalid argument type/value: ${key}`,
      }
    }
  }

  return { ok: true, value: { ...args } }
}

function validateRootJsonSchema(
  schema: Readonly<Record<string, unknown>>,
  args: Record<string, unknown>,
): ToolArgumentValidation {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((x): x is string => typeof x === 'string')
      : [],
  )
  const allowAdditional = schema.additionalProperties !== false

  if (!allowAdditional) {
    for (const key of Object.keys(args)) {
      if (!(key in properties)) {
        return { ok: false, value: null, error: `unknown argument: ${key}` }
      }
    }
  }

  for (const key of required) {
    if (args[key] === undefined || args[key] === null) {
      return { ok: false, value: null, error: `missing argument: ${key}` }
    }
  }

  for (const [key, raw] of Object.entries(properties)) {
    const value = args[key]
    if (value === undefined || value === null) continue
    if (!matchesJsonSchema(raw, value)) {
      return {
        ok: false,
        value: null,
        error: `invalid argument type/value: ${key}`,
      }
    }
  }

  return { ok: true, value: { ...args } }
}

function matchesCompactType(def: ArgumentSchema, value: unknown): boolean {
  switch (def.type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'object':
      return isRecord(value)
    case 'enum':
      return typeof value === 'string' && (def.values ?? []).includes(value)
  }
}

function matchesJsonSchema(raw: unknown, value: unknown): boolean {
  if (!isRecord(raw)) return true
  if (Array.isArray(raw.enum)) {
    return raw.enum.some((entry) => Object.is(entry, value))
  }
  switch (raw.type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'object':
      return isRecord(value)
    case 'array':
      return Array.isArray(value)
    default:
      return true
  }
}

function asArgumentSchema(value: unknown): ArgumentSchema | null {
  if (!isRecord(value)) return null
  if (!['string', 'number', 'boolean', 'enum', 'object'].includes(String(value.type))) {
    return null
  }
  return value as unknown as ArgumentSchema
}

function isRootJsonSchema(
  value: Readonly<Record<string, unknown>>,
): boolean {
  return (
    value.type === 'object' &&
    (value.properties === undefined || isRecord(value.properties))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
