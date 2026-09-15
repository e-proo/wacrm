import { describe, it, expect } from 'vitest'
import {
  classifyCandidate,
  overallMatch,
  SERVICE_MATCH_SELECT,
  type MatchedCandidate,
} from './service-matcher'
import type { FieldDefinitionInput } from '@/lib/services/catalog/field-schema'

// The matcher is the agent's honesty gate: it must classify a
// request as exact / partial / none and NEVER force a customer's
// words into an equipped schema.

const remittanceDefs: FieldDefinitionInput[] = [
  { field_key: 'destination_city', label: 'City', data_type: 'region', required: true, visibility: 'public', constraints: {}, display_order: 10, is_filterable: false },
  { field_key: 'amount', label: 'Amount', data_type: 'money', required: true, visibility: 'public', constraints: {}, display_order: 20, is_filterable: false } as unknown as FieldDefinitionInput,
  { field_key: 'receiver_name', label: 'Receiver', data_type: 'short_text', required: true, visibility: 'public', constraints: {}, display_order: 30, is_filterable: false },
  { field_key: 'notes', label: 'Notes', data_type: 'short_text', required: false, visibility: 'internal', constraints: {}, display_order: 40, is_filterable: false },
]

describe('classifyCandidate', () => {
  it('exact when all required fields present and nothing unknown', () => {
    const r = classifyCandidate(
      { destination_city: 'KL', amount: 1000, receiver_name: 'Ali' },
      remittanceDefs,
    )
    expect(r.classification).toBe('exact')
    expect(r.missing_fields).toEqual([])
    expect(r.unknown_fields).toEqual([])
  })

  it('partial when required fields are missing (agent should ask)', () => {
    const r = classifyCandidate(
      { destination_city: 'KL', amount: 1000 },
      remittanceDefs,
    )
    expect(r.classification).toBe('partial')
    expect(r.missing_fields).toEqual(['receiver_name'])
  })

  it('partial when the customer mentioned extra undeclared fields', () => {
    const r = classifyCandidate(
      { destination_city: 'KL', amount: 1000, receiver_name: 'Ali', bank_swift: 'XYZ' },
      remittanceDefs,
    )
    expect(r.classification).toBe('partial')
    expect(r.unknown_fields).toEqual(['bank_swift'])
  })

  it('none when too many required fields are missing', () => {
    const r = classifyCandidate({ destination_city: 'KL' }, remittanceDefs)
    expect(r.classification).toBe('none')
    expect(r.missing_fields).toHaveLength(2)
  })

  it('never treats optional fields as missing', () => {
    const r = classifyCandidate(
      { destination_city: 'KL', amount: 1000, receiver_name: 'Ali' },
      remittanceDefs,
    )
    expect(r.missing_fields).toEqual([])
  })

  it('empty schema with no required fields is exact for any request', () => {
    const r = classifyCandidate({ anything: 1 }, [])
    expect(r.classification).toBe('partial') // unknown key present
    expect(r.unknown_fields).toEqual(['anything'])
  })
})

describe('overallMatch', () => {
  function candidate(
    over: Partial<MatchedCandidate> & { classification: MatchedCandidate['classification'] },
  ): MatchedCandidate {
    return {
      service_id: 's1',
      name: 'S',
      code: 'C',
      category_id: 'cat',
      missing_fields: [],
      unknown_fields: [],
      ...over,
    }
  }

  it('exact wins over partial', () => {
    expect(
      overallMatch([
        candidate({ classification: 'partial' }),
        candidate({ classification: 'exact' }),
      ]),
    ).toBe('exact')
  })

  it('partial over none', () => {
    expect(overallMatch([candidate({ classification: 'none' }), candidate({ classification: 'partial' })])).toBe('partial')
  })

  it('none when nothing fits', () => {
    expect(overallMatch([candidate({ classification: 'none' })])).toBe('none')
  })
})

describe('service matcher query contract', () => {
  it('pins current revision and does not use an ambiguous category embed', () => {
    expect(SERVICE_MATCH_SELECT).toContain('service_revisions!services_current_revision_fk')
    expect(SERVICE_MATCH_SELECT).not.toContain('service_categories(')
  })
})
