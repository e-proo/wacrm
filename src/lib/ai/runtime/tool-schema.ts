import type { ToolDefinition, ArgumentSchema } from './tool-registry'

export interface ToolArgumentValidation {
  ok: boolean
  value: Record<string, unknown> | null
  error?: string
}

/** Convert the repo's closed ArgumentSchema into provider JSON Schema. */
export function toJsonSchema(tool: ToolDefinition): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, def] of Object.entries(tool.argumentSchema)) {
    properties[name] = argumentToJsonSchema(def)
    // Existing registry semantics: required unless explicitly false.
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
  const base: Record<string, unknown> = { description: def.description }
  switch (def.type) {
    case 'string': return { ...base, type: 'string' }
    case 'number': return { ...base, type: 'number' }
    case 'boolean': return { ...base, type: 'boolean' }
    case 'enum': return { ...base, type: 'string', enum: def.values ?? [] }
    case 'object': return { ...base, type: 'object' }
  }
}

/**
 * Strict top-level validator used even when a provider claims to support
 * strict schemas. Provider output is always untrusted: unknown keys fail,
 * required keys fail, enums/types fail, and non-object args fail.
 */
export function validateToolArguments(
  tool: ToolDefinition,
  args: unknown,
): ToolArgumentValidation {
  if (!isRecord(args)) return { ok: false, value: null, error: 'arguments must be an object' }

  const known = new Set(Object.keys(tool.argumentSchema))
  for (const key of Object.keys(args)) {
    if (!known.has(key)) return { ok: false, value: null, error: `unknown argument: ${key}` }
  }

  for (const [key, def] of Object.entries(tool.argumentSchema)) {
    const value = args[key]
    if (value === undefined || value === null) {
      if (def.required !== false) return { ok: false, value: null, error: `missing argument: ${key}` }
      continue
    }
    if (!matchesType(def, value)) {
      return { ok: false, value: null, error: `invalid argument type/value: ${key}` }
    }
  }

  return { ok: true, value: { ...args } }
}

function matchesType(def: ArgumentSchema, value: unknown): boolean {
  switch (def.type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    case 'object': return isRecord(value)
    case 'enum': return typeof value === 'string' && (def.values ?? []).includes(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
