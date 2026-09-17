import { describe, expect, it } from 'vitest'
import { normalizeCoverageProposalMethod } from './coverage-proposal-resilient'

describe('coverage proposal normalization', () => {
  it('maps common Arabic customer methods to the canonical enum', () => {
    expect(normalizeCoverageProposalMethod('نقدًا')).toBe('cash')
    expect(normalizeCoverageProposalMethod('شبكات')).toBe('networks')
    expect(normalizeCoverageProposalMethod('شبكة')).toBe('networks')
    expect(normalizeCoverageProposalMethod('حوالة')).toBe('remittance')
    expect(normalizeCoverageProposalMethod('إيداع بنكي')).toBe('bank_deposit')
  })

  it('preserves canonical methods and rejects unknown values', () => {
    expect(normalizeCoverageProposalMethod('cash')).toBe('cash')
    expect(normalizeCoverageProposalMethod('bank_deposit')).toBe('bank_deposit')
    expect(normalizeCoverageProposalMethod('unknown-method')).toBeNull()
  })
})
