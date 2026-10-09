import { describe, expect, it } from 'vitest'
import { serviceSearchTermsForTest } from './service-search'

describe('service search terms', () => {
  it('keeps the full phrase and individual Arabic words', () => {
    expect(serviceSearchTermsForTest('تغطية شبكات')).toEqual([
      'تغطية شبكات',
      'تغطية',
      'شبكات',
    ])
  })

  it('normalizes separators and removes duplicate terms', () => {
    expect(serviceSearchTermsForTest('coverage, coverage')).toEqual([
      'coverage coverage',
      'coverage',
    ])
  })
})
