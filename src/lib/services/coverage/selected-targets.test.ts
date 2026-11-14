import { describe, expect, it } from 'vitest'
import {
  MAX_EXPLICIT_COVERAGE_CONTACTS,
  normalizeExplicitCoverageContactIds,
  parseExplicitCoverageContactIds,
  sameExplicitCoverageContacts,
} from './selected-targets'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

describe('explicit Coverage Task CRM recipient scope', () => {
  it('accepts only exact, ordered, unique CRM contact IDs', () => {
    expect(MAX_EXPLICIT_COVERAGE_CONTACTS).toBe(20)
    expect(parseExplicitCoverageContactIds({ selectedContactIds: [B,A,C] }))
      .toEqual([B,A,C])
    expect(parseExplicitCoverageContactIds({ selectedContactId: A }))
      .toEqual([A])
    expect(parseExplicitCoverageContactIds({})).toBe(null)
    expect(normalizeExplicitCoverageContactIds({
      selectedContactIds: [A,B],
    })).toEqual([A,B])
    expect(sameExplicitCoverageContacts([A,B], [A,B])).toBe(true)
    expect(sameExplicitCoverageContacts([A,B], [B,A])).toBe(false)
    expect(sameExplicitCoverageContacts([A,B], [A])).toBe(false)
    expect(sameExplicitCoverageContacts(null, null)).toBe(true)
  })
  it('never converts invalid or empty explicit lists to implicit automatic targeting', () => {
    for (const ids of [
      [], [A,A], ['wrong-tenant'], [A,' '],
      Array.from({length:21},(_,i)=>String(i)),
    ]) {
      expect(() => parseExplicitCoverageContactIds({
        selectedContactIds: ids,
      })).toThrow('COVERAGE_SELECTED_CONTACTS_INVALID')
    }
    expect(() => parseExplicitCoverageContactIds({
      selectedContactIds: [A,B], selectedContactId: A,
    })).toThrow('COVERAGE_SELECTED_CONTACT_MODES_CONFLICT')
    expect(() => normalizeExplicitCoverageContactIds({
      selectedContactId: A, selectedContactIds: [B],
    })).toThrow('COVERAGE_SELECTED_CONTACT_MODES_CONFLICT')
    expect(() => parseExplicitCoverageContactIds({
      selectedContactId: null,
    })).toThrow('COVERAGE_SELECTED_CONTACTS_INVALID')
    expect(normalizeExplicitCoverageContactIds({
      selectedContactId: null, selectedContactIds: undefined,
    })).toBe(null)
  })
})
