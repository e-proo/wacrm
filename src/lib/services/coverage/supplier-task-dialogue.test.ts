import { describe, expect, it } from 'vitest'
import {
  advanceSupplierTurn, initialSupplierState, normalizeSupplierNumber,
  parseSupplierNumber, supplierConfirmsFinal,
} from './supplier-task-dialogue'

const facts = { remainingAmount: '400', currency: 'SAR' }
describe('coverage.sourcing@2 durable supplier negotiation', () => {
  it('requires amount, negotiated commission, detailed terms and explicit confirmation before admin proposal', () => {
    const yes = advanceSupplierTurn(initialSupplierState(), 'نعم يمكنني توفير التغطية', facts)
    expect(yes.next.stage).toBe('amount')
    expect(yes.action).toBe('reply')
    expect(yes.response).toContain('400 SAR')

    const amount = advanceSupplierTurn(yes.next, '٤٠٠', facts)
    expect(amount.next).toMatchObject({ stage: 'commission', offeredAmount: '400' })
    const commission = advanceSupplierTurn(amount.next, '٧', facts)
    expect(commission.next).toMatchObject({ stage: 'details', commissionPerThousand: '7' })
    const details = advanceSupplierTurn(commission.next,
      'التسليم في المكلا والاستلام في إب عبر حوالة، التغطية متاحة اليوم', facts)
    expect(details.next.stage).toBe('confirmation')
    expect(details.response).toContain('7 لكل 1000')
    expect(details.response).toContain('400 SAR')
    expect(details.action).toBe('reply')

    const unclear = advanceSupplierTurn(details.next, 'تمام', facts)
    expect(unclear.next.stage).toBe('confirmation')
    expect(unclear.action).toBe('reply')
    const affirmed = advanceSupplierTurn(details.next, 'تأكيد', facts)
    expect(affirmed.action).toBe('submit')
    expect(affirmed.next.stage).toBe('submitting')
  })

  it('does not invent an amount or rate or send a proposal for a vague affirmative', () => {
    const start = advanceSupplierTurn(initialSupplierState(), 'يمكنني توفيرها', facts)
    expect(start.next.stage).toBe('amount')
    const vague = advanceSupplierTurn(start.next, 'نعم', facts)
    expect(vague.action).toBe('reply')
    expect(vague.next.offeredAmount).toBe(null)
    const invalid = advanceSupplierTurn(start.next, '1000', facts)
    expect(invalid.next.stage).toBe('amount')
    const amount = advanceSupplierTurn(start.next, '200.50', facts)
    expect(amount.next.offeredAmount).toBe('200.50')
    const missingRate = advanceSupplierTurn(amount.next, 'ربما سبعة', facts)
    expect(missingRate.next.stage).toBe('commission')
    expect(missingRate.action).toBe('reply')
    expect(missingRate.next.commissionPerThousand).toBe(null)
    const rate = advanceSupplierTurn(amount.next, '0', facts)
    expect(rate.next.commissionPerThousand).toBe('0')
    const shortDetail = advanceSupplierTurn(rate.next, 'إب', facts)
    expect(shortDetail.next.stage).toBe('details')
    expect(shortDetail.action).toBe('reply')
  })

  it('retains explicitly confirmed commission from legacy question but asks amount and details', () => {
    const previousCommission = {
      ...initialSupplierState(), commissionPerThousand: '7',
    }
    const accepted = advanceSupplierTurn(previousCommission, 'نعم أؤكد', facts)
    expect(accepted.next.stage).toBe('amount')
    expect(accepted.next.commissionPerThousand).toBe('7')
    const amount = advanceSupplierTurn(accepted.next, '400', facts)
    expect(amount.next.stage).toBe('details')
  })

  it('denies declined supplier and does not fabricate a Change Request', () => {
    const response = advanceSupplierTurn(initialSupplierState(), 'لا أستطيع', facts)
    expect(response.action).toBe('decline')
    expect(response.next.stage).toBe('declined')
    expect(advanceSupplierTurn(response.next, 'تأكيد', facts).action).toBe('reply')
  })

  it('allows correction of the whole quote but no confirmation of incomplete terms', () => {
    const missing = advanceSupplierTurn({
      ...initialSupplierState(), stage: 'confirmation', offeredAmount: '400',
    }, 'تأكيد', facts)
    expect(missing.action).toBe('reply')
    const corrected = advanceSupplierTurn({
      stage: 'confirmation', offeredAmount: '400', commissionPerThousand: '7',
      supplierDetails: 'تفاصيل نقل محددة واضحة',
    }, 'تعديل', facts)
    expect(corrected.next).toEqual(initialSupplierState())
    expect(corrected.action).toBe('reply')
  })

  it('supports Arabic/Persian numerals but rejects injection and unsupported amounts', () => {
    expect(normalizeSupplierNumber('۷/١٠٠٠')).toBe('7/1000')
    expect(parseSupplierNumber('٧ لكل 1000', 1000, true)).toBe('7')
    expect(parseSupplierNumber('۴۰۰', 400)).toBe('400')
    expect(parseSupplierNumber('401', 400)).toBe(null)
    expect(parseSupplierNumber('-10', 400)).toBe(null)
    expect(parseSupplierNumber('0', 400)).toBe(null)
    expect(parseSupplierNumber('100 OR 1=1', 400)).toBe(null)
    expect(supplierConfirmsFinal('نعم أؤكد')).toBe(true)
    expect(supplierConfirmsFinal('تمام')).toBe(false)
  })

  it('never treats a repeated confirmation after submitting as another proposal', () => {
    const state = { ...initialSupplierState(), stage: 'submitting' as const }
    expect(advanceSupplierTurn(state, 'تأكيد', facts).action).toBe('reply')
  })
})
