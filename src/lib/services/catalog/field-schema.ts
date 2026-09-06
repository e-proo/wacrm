// ============================================================
// Field schema compiler — turns a service_category_schema_version's
// field_definitions[] into a strict validator for service
// `field_values` JSONB.
//
// Phase 2 keeps the compiler pure: it does not read from a DB.
// Callers fetch the field definitions, hand them to
// `compileFieldSchema`, then call `validateValues` against the
// returned schema. This is so the compiler is unit-testable
// without any infra.
//
// Deny by default:
//   • keys not declared in the schema are rejected (unknown key)
//   • required fields MUST be present
//   • types are enforced via the closed `data_type` enum
//   • visibility is enforced via the field's `visibility`
//     setting + the caller's intent (public / internal / ai_only)
// ============================================================

import type { FieldVisibility } from './field-types'

export type FieldDataType =
  | 'short_text'
  | 'long_text'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'money'
  | 'currency'
  | 'percentage'
  | 'per_unit_rate'
  | 'enum'
  | 'multi_enum'
  | 'region'
  | 'payment_method'
  | 'date'
  | 'datetime'

export interface FieldDefinitionInput {
  field_key: string
  label: string
  help_text?: string | null
  data_type: FieldDataType
  required: boolean
  visibility: FieldVisibility
  constraints: Record<string, unknown>
  display_order: number
  is_filterable: boolean
}

export interface CompiledSchema {
  fields: FieldDefinitionInput[]
  /** Fast lookup by key. */
  byKey: Map<string, FieldDefinitionInput>
}

export interface ValidationError {
  field_key: string
  code:
    | 'UNKNOWN_KEY'
    | 'REQUIRED'
    | 'INVALID_TYPE'
    | 'OUT_OF_RANGE'
    | 'NOT_IN_ENUM'
    | 'INVALID_FORMAT'
  message: string
}

export interface ValidationResult {
  ok: boolean
  errors: ValidationError[]
  /** Values normalized (typed) — only present when ok. */
  normalized?: Record<string, unknown>
}

export function compileFieldSchema(
  definitions: FieldDefinitionInput[],
): CompiledSchema {
  // Stable order by display_order + key for deterministic error
  // messages.
  const sorted = [...definitions].sort((a, b) => {
    if (a.display_order !== b.display_order) {
      return a.display_order - b.display_order
    }
    return a.field_key.localeCompare(b.field_key)
  })
  const byKey = new Map<string, FieldDefinitionInput>()
  for (const def of sorted) {
    byKey.set(def.field_key, def)
  }
  return { fields: sorted, byKey }
}

/**
 * Validate a JSONB values blob against the schema.
 *
 * `intent` controls which visibility levels are accepted:
 *   'public'  — only `public` fields are visible in the result.
 *                Unknown/internal/ai_only fields produce
 *                UNKNOWN_KEY errors.
 *   'internal' — public + internal fields are visible.
 *                 ai_only fields are UNKNOWN_KEY.
 *   'ai'       — public + ai_only fields are visible.
 *                internal fields are UNKNOWN_KEY.
 *   'full'     — every declared field is visible (admin).
 */
export function validateValues(
  schema: CompiledSchema,
  values: Record<string, unknown> | null | undefined,
  intent: 'public' | 'internal' | 'ai' | 'full' = 'full',
): ValidationResult {
  const errors: ValidationError[] = []
  const normalized: Record<string, unknown> = {}
  const v = values ?? {}

  // 1) Reject unknown keys (those not declared in the schema).
  for (const key of Object.keys(v)) {
    const def = schema.byKey.get(key)
    if (!def) {
      errors.push({
        field_key: key,
        code: 'UNKNOWN_KEY',
        message: `Field "${key}" is not declared in the schema.`,
      })
      continue
    }
    if (!isVisibilityAllowed(def.visibility, intent)) {
      errors.push({
        field_key: key,
        code: 'UNKNOWN_KEY',
        message: `Field "${key}" is not accessible from intent "${intent}".`,
      })
      continue
    }
  }

  // 2) Enforce presence + type for every declared field the
  //    intent is allowed to see.
  for (const def of schema.fields) {
    if (!isVisibilityAllowed(def.visibility, intent)) continue
    const raw = v[def.field_key]
    if (raw === undefined || raw === null) {
      if (def.required) {
        errors.push({
          field_key: def.field_key,
          code: 'REQUIRED',
          message: `Field "${def.field_key}" is required.`,
        })
      }
      continue
    }
    const typeCheck = checkType(def, raw)
    if (typeCheck.error) {
      errors.push(typeCheck.error)
      continue
    }
    if (typeCheck.normalized !== undefined) {
      normalized[def.field_key] = typeCheck.normalized
    } else {
      normalized[def.field_key] = raw
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    normalized: errors.length === 0 ? normalized : undefined,
  }
}

function isVisibilityAllowed(
  v: FieldVisibility,
  intent: 'public' | 'internal' | 'ai' | 'full',
): boolean {
  if (intent === 'full') return true
  if (intent === 'public') return v === 'public'
  if (intent === 'internal') return v === 'public' || v === 'internal'
  if (intent === 'ai') return v === 'public' || v === 'ai_only'
  return false
}

interface TypeCheckResult {
  error?: ValidationError
  normalized?: unknown
}

function checkType(
  def: FieldDefinitionInput,
  value: unknown,
): TypeCheckResult {
  switch (def.data_type) {
    case 'short_text':
    case 'long_text': {
      if (typeof value !== 'string') {
        return errorResult(def, 'INVALID_TYPE', 'Expected string.')
      }
      const maxLength =
        typeof def.constraints.max_length === 'number'
          ? def.constraints.max_length
          : def.data_type === 'short_text'
            ? 200
            : 4000
      if (value.length > maxLength) {
        return errorResult(
          def,
          'OUT_OF_RANGE',
          `Exceeds max length ${maxLength}.`,
        )
      }
      return {}
    }
    case 'number':
    case 'percentage':
    case 'per_unit_rate': {
      const n = typeof value === 'string' ? Number(value) : (value as number)
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        return errorResult(def, 'INVALID_TYPE', 'Expected number.')
      }
      return { normalized: n }
    }
    case 'integer': {
      const n = typeof value === 'string' ? Number(value) : (value as number)
      if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
        return errorResult(def, 'INVALID_TYPE', 'Expected integer.')
      }
      return { normalized: n }
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        return errorResult(def, 'INVALID_TYPE', 'Expected boolean.')
      }
      return {}
    }
    case 'money': {
      // Canonical shape: { amount: "100.00", currency: "YER" }.
      if (
        typeof value !== 'object' ||
        value === null ||
        typeof (value as { amount?: unknown }).amount !== 'string' ||
        typeof (value as { currency?: unknown }).currency !== 'string'
      ) {
        return errorResult(
          def,
          'INVALID_FORMAT',
          'Expected { amount: string, currency: string }.',
        )
      }
      return {}
    }
    case 'currency': {
      if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
        return errorResult(
          def,
          'INVALID_FORMAT',
          'Expected ISO-4217-like 3-letter currency code.',
        )
      }
      return {}
    }
    case 'enum': {
      const allowed = def.constraints.allowed_values as unknown
      if (
        !Array.isArray(allowed) ||
        typeof value !== 'string' ||
        !allowed.includes(value)
      ) {
        return errorResult(
          def,
          'NOT_IN_ENUM',
          `Value not in the allowed list.`,
        )
      }
      return {}
    }
    case 'multi_enum': {
      const allowed = def.constraints.allowed_values as unknown
      if (
        !Array.isArray(allowed) ||
        !Array.isArray(value) ||
        !value.every((v) => typeof v === 'string' && allowed.includes(v))
      ) {
        return errorResult(
          def,
          'NOT_IN_ENUM',
          'Each value must be in the allowed list.',
        )
      }
      return {}
    }
    case 'region':
    case 'payment_method': {
      // Phase 2 keeps these as free-form strings + a length cap;
      // a closed vocabulary lands with Phase 2 §17 (vocab tables).
      if (typeof value !== 'string' || value.length > 100) {
        return errorResult(def, 'INVALID_FORMAT', 'Expected short string.')
      }
      return {}
    }
    case 'date':
    case 'datetime': {
      if (typeof value !== 'string') {
        return errorResult(def, 'INVALID_TYPE', 'Expected ISO date string.')
      }
      if (Number.isNaN(Date.parse(value))) {
        return errorResult(def, 'INVALID_FORMAT', 'Unparseable date.')
      }
      return {}
    }
    default: {
      const exhaustive: never = def.data_type
      return errorResult(
        def,
        'INVALID_TYPE',
        `Unknown data type: ${String(exhaustive)}`,
      )
    }
  }
}

function errorResult(
  def: FieldDefinitionInput,
  code: ValidationError['code'],
  message: string,
): TypeCheckResult {
  return {
    error: {
      field_key: def.field_key,
      code,
      message,
    },
  }
}
