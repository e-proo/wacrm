import { describe, it, expect } from 'vitest'
import {
  compileFieldSchema,
  validateValues,
  type FieldDefinitionInput,
} from './field-schema'

const fields: FieldDefinitionInput[] = [
  {
    field_key: 'coverage_region',
    label: 'Coverage region',
    data_type: 'region',
    required: true,
    visibility: 'public',
    constraints: {},
    display_order: 10,
    is_filterable: true,
  },
  {
    field_key: 'deposit_method',
    label: 'Deposit method',
    data_type: 'enum',
    required: true,
    visibility: 'public',
    constraints: { allowed_values: ['cash', 'bank', 'wallet'] },
    display_order: 20,
    is_filterable: true,
  },
  {
    field_key: 'provider_cost_basis',
    label: 'Provider cost basis',
    data_type: 'money',
    required: false,
    visibility: 'internal',
    constraints: {},
    display_order: 30,
    is_filterable: false,
  },
  {
    field_key: 'ai_guidance_note',
    label: 'AI guidance',
    data_type: 'long_text',
    required: false,
    visibility: 'ai_only',
    constraints: {},
    display_order: 40,
    is_filterable: false,
  },
  {
    field_key: 'coverage_amount',
    label: 'Coverage amount',
    data_type: 'number',
    required: true,
    visibility: 'public',
    constraints: { min: 0 },
    display_order: 5,
    is_filterable: false,
  },
]

const schema = compileFieldSchema(fields)

describe('compileFieldSchema', () => {
  it('sorts fields by display_order', () => {
    expect(schema.fields.map((f) => f.field_key)).toEqual([
      'coverage_amount',
      'coverage_region',
      'deposit_method',
      'provider_cost_basis',
      'ai_guidance_note',
    ])
  })
})

describe('validateValues — full intent', () => {
  it('accepts a well-formed full payload', () => {
    const r = validateValues(
      schema,
      {
        coverage_amount: 10000,
        coverage_region: 'sanaa',
        deposit_method: 'cash',
        provider_cost_basis: { amount: '5000.00', currency: 'YER' },
        ai_guidance_note: 'ask for network and city first',
      },
      'full',
    )
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('rejects unknown keys', () => {
    const r = validateValues(
      schema,
      {
        coverage_amount: 10000,
        coverage_region: 'sanaa',
        deposit_method: 'cash',
        rogue_field: 'no',
      },
      'full',
    )
    expect(r.ok).toBe(false)
    expect(r.errors.find((e) => e.field_key === 'rogue_field')).toBeDefined()
  })

  it('flags missing required fields', () => {
    const r = validateValues(
      schema,
      {
        coverage_region: 'sanaa',
      },
      'full',
    )
    expect(r.ok).toBe(false)
    const codes = r.errors.map((e) => e.field_key + ':' + e.code).sort()
    expect(codes).toContain('coverage_amount:REQUIRED')
    expect(codes).toContain('deposit_method:REQUIRED')
  })

  it('rejects an enum value outside the allowlist', () => {
    const r = validateValues(
      schema,
      {
        coverage_amount: 1,
        coverage_region: 'x',
        deposit_method: 'rocket',
      },
      'full',
    )
    expect(r.errors.find((e) => e.field_key === 'deposit_method')?.code).toBe(
      'NOT_IN_ENUM',
    )
  })

  it('rejects a malformed money object', () => {
    const r = validateValues(
      schema,
      {
        coverage_amount: 1,
        coverage_region: 'x',
        deposit_method: 'cash',
        provider_cost_basis: { amount: 5, currency: 'YER' },
      },
      'full',
    )
    expect(
      r.errors.find((e) => e.field_key === 'provider_cost_basis')?.code,
    ).toBe('INVALID_FORMAT')
  })
})

describe('validateValues — visibility scoping', () => {
  it('public intent rejects internal fields', () => {
    const r = validateValues(
      schema,
      {
        coverage_amount: 1,
        coverage_region: 'x',
        deposit_method: 'cash',
        provider_cost_basis: { amount: '5.00', currency: 'YER' },
      },
      'public',
    )
    expect(r.ok).toBe(false)
    expect(
      r.errors.find((e) => e.field_key === 'provider_cost_basis'),
    ).toBeDefined()
  })

  it('ai intent accepts ai_only but rejects internal', () => {
    const r = validateValues(
      schema,
      {
        coverage_amount: 1,
        coverage_region: 'x',
        deposit_method: 'cash',
        ai_guidance_note: 'ask first',
        provider_cost_basis: { amount: '5.00', currency: 'YER' },
      },
      'ai',
    )
    expect(r.ok).toBe(false)
    expect(r.errors.find((e) => e.field_key === 'ai_guidance_note')).toBeUndefined()
    expect(
      r.errors.find((e) => e.field_key === 'provider_cost_basis'),
    ).toBeDefined()
  })
})
