import { describe, expect, it } from 'vitest'
import {
  normalizeCoverageAttributes,
  readCoverageAttributes,
} from './attributes'

describe('normalizeCoverageAttributes', () => {
  it('normalizes a full valid blob', () => {
    const result = normalizeCoverageAttributes({
      coverage_scope: 'international',
      coverage_country: '  Malaysia  ',
      receive_region_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      receive_method: 'cash',
      pay_region_id: '8f14e45f-ceea-467f-a870-a5a6c6a4d5c1',
      pay_method: 'networks',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.normalized).toEqual({
        coverage_scope: 'international',
        coverage_country: 'Malaysia',
        receive_region_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        receive_method: 'cash',
        pay_region_id: '8f14e45f-ceea-467f-a870-a5a6c6a4d5c1',
        pay_method: 'networks',
      })
    }
  })

  it('falls back to defaults for an empty blob', () => {
    const result = normalizeCoverageAttributes({})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.normalized.coverage_scope).toBe('domestic')
      expect(result.normalized.receive_method).toBe('any')
      expect(result.normalized.pay_method).toBe('any')
      expect(result.normalized.receive_region_id).toBeNull()
    }
  })

  it('accepts null/undefined input', () => {
    expect(normalizeCoverageAttributes(null).ok).toBe(true)
    expect(normalizeCoverageAttributes(undefined).ok).toBe(true)
  })

  it('rejects unknown keys (deny by default)', () => {
    const result = normalizeCoverageAttributes({ hacker_field: 'x' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe('UNKNOWN_KEY')
      expect(result.errors[0]?.field).toBe('hacker_field')
    }
  })

  it('rejects a method outside the closed enum', () => {
    const result = normalizeCoverageAttributes({ receive_method: 'carrier_pigeon' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]?.field).toBe('receive_method')
      expect(result.errors[0]?.code).toBe('NOT_IN_ENUM')
    }
  })

  it('rejects a malformed region id', () => {
    const result = normalizeCoverageAttributes({ pay_region_id: 'not-a-uuid' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe('INVALID_FORMAT')
    }
  })

  it('rejects a non-string country', () => {
    const result = normalizeCoverageAttributes({ coverage_country: 42 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]?.field).toBe('coverage_country')
    }
  })
})

describe('readCoverageAttributes', () => {
  it('never throws on legacy/garbage rows', () => {
    const attrs = readCoverageAttributes({ nonsense: true, receive_method: 7 })
    expect(attrs.coverage_scope).toBe('domestic')
    expect(attrs.receive_method).toBe('any')
    expect(attrs.pay_method).toBe('any')
  })

  it('reads valid rows back with defaults applied', () => {
    const attrs = readCoverageAttributes({ receive_method: 'networks' })
    expect(attrs.receive_method).toBe('networks')
    expect(attrs.coverage_scope).toBe('domestic')
  })
})
