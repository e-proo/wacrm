export type FieldVisibility = 'public' | 'internal' | 'ai_only'

export const FIELD_DATA_TYPES = [
  'short_text',
  'long_text',
  'number',
  'integer',
  'boolean',
  'money',
  'currency',
  'percentage',
  'per_unit_rate',
  'enum',
  'multi_enum',
  'region',
  'payment_method',
  'date',
  'datetime',
] as const

export type FieldDataType = (typeof FIELD_DATA_TYPES)[number]

export const FIELD_VISIBILITIES: readonly FieldVisibility[] = [
  'public',
  'internal',
  'ai_only',
]

export function isFieldVisibility(value: unknown): value is FieldVisibility {
  return (
    typeof value === 'string' &&
    (FIELD_VISIBILITIES as readonly string[]).includes(value)
  )
}
