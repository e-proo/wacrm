import {describe,expect,it} from 'vitest'
import {advanceSupplierTurn,initialSupplierState,
  parseSupplierNumber,supplierConfirmsRoute,supplierConfirmsFinal} from './supplier-task-dialogue'

const facts = {remainingAmount:'550',currency:'SAR',
  route:{requesterPayRegionId:'00000000-0000-4000-8000-000000000001',
    requesterPayRegion:'صنعاء',requesterPayMethod:'أي طريقة متاحة',
    requesterReceiveRegionId:'00000000-0000-4000-8000-000000000002',
    requesterReceiveRegion:'حضرموت',requesterReceiveMethod:'أي طريقة متاحة',
    scope:'domestic' as const,country:null},
  knownRegions:[{id:'00000000-0000-4000-8000-000000000001',name:'صنعاء'},
    {id:'00000000-0000-4000-8000-000000000002',name:'حضرموت'},
    {id:'00000000-0000-4000-8000-000000000003',name:'إب'}]}

describe('concise supplier negotiation',()=>{
  it('submits the user-reported full 550 SAR / 7 per 1000 offer in one turn',()=>{
    const reply='نعم واستطيع توفير المبلغ كامل 550 واريد عموله 7 لكل 1000 وطريقة الدفع والاستلام اي طريقة متوفر عادي اكد على العرض'
    const step=advanceSupplierTurn(initialSupplierState(),reply,facts)
    expect(step.action).toBe('submit')
    expect(step.next).toMatchObject({stage:'submitting',offeredAmount:'550',
      commissionPerThousand:'7',routeConfirmed:true,routeDifferent:false,
      supplierDetails:reply})
  })
  it('requests only missing numerical terms if the first "yes" accepts the detailed advertised route',()=>{
    const first=advanceSupplierTurn(initialSupplierState(),'نعم',facts)
    expect(first.next.routeConfirmed).toBe(true)
    expect(first.response).toContain('المبلغ')
    expect(first.response).toContain('العمولة')
    expect(first.response).not.toContain('نطاق التغطية')
    const next=advanceSupplierTurn(first.next,'550',facts)
    expect(next.next.offeredAmount).toBe('550')
    expect(next.response).not.toContain('كم مبلغ')
    const rate=advanceSupplierTurn(next.next,'7',facts)
    expect(rate.action).toBe('submit')
    expect(rate.next.commissionPerThousand).toBe('7')
  })
  it('accepts natural "نعم المسار مطابق" and does not require magic words',()=>{
    expect(supplierConfirmsRoute('نعم المسار مطابق')).toBe(true)
    const step=advanceSupplierTurn({...initialSupplierState(),stage:'route'},'نعم المسار مطابق',facts)
    expect(step.next.routeConfirmed).toBe(true)
    expect(step.next.stage).toBe('amount')
    expect(step.response).not.toContain('لم نتلق')
  })
  it('routes explicit different terms as a counteroffer, not rejection',()=>{
    const text='نعم اوفر 500 ريال وعمولتي 9 لكل 1000 لكن استلم في إب بدل صنعاء، اكد العرض'
    const s=advanceSupplierTurn(initialSupplierState(),text,facts)
    expect(s.action).toBe('submit')
    expect(s.next).toMatchObject({stage:'submitting',routeDifferent:true,
      routeConfirmed:false,offeredAmount:'500',commissionPerThousand:'9'})
  })
  it('asks only for alternative location when supplier has not provided it',()=>{
    const s=advanceSupplierTurn(initialSupplierState(),
      'المسار مختلف واوفر 500 ريال وعمولتي 7 لكل 1000',facts)
    expect(s.action).toBe('reply')
    expect(s.next.routeDifferent).toBe(true)
    expect(s.response).toContain('جهة التسليم')
    expect(s.response).not.toContain('كم مبلغ')
    const located=advanceSupplierTurn(s.next,'أستلم في إب بدل صنعاء',facts)
    expect(located.action).toBe('submit')
    expect(located.next.supplierDetails).toContain('500')
    expect(located.next.supplierDetails).toContain('إب')
  })
  it('never invents missing money or commission',()=>{
    const step=advanceSupplierTurn(initialSupplierState(),'نعم أقدر أوفرها',facts)
    expect(step.next.offeredAmount).toBe(null)
    expect(step.next.commissionPerThousand).toBe(null)
    expect(step.action).toBe('reply')
  })
  it('can still explicitly decline or opt to edit a quote',()=>{
    expect(advanceSupplierTurn(initialSupplierState(),'لا أستطيع',facts).action).toBe('decline')
    const quote=advanceSupplierTurn(initialSupplierState(),'نعم 550 وعمولة 7',facts)
    expect(quote.action).toBe('submit')
    expect(advanceSupplierTurn({...quote.next,stage:'submitted'},'نعم',facts).action).toBe('reply')
    expect(advanceSupplierTurn({...quote.next,stage:'confirmation'},'تعديل',facts).next)
      .toEqual(initialSupplierState())
  })
  it('does not confuse no extra conditions with a refusal to provide coverage',()=>{
    expect(advanceSupplierTurn(initialSupplierState(),'لا توجد شروط إضافية',facts).action)
      .not.toBe('decline')
  })
  it('supports Arabic digits and requires a real amount',()=>{
    expect(parseSupplierNumber('٥٥٠',550)).toBe('550')
    expect(parseSupplierNumber('٧ لكل 1000',1000,true)).toBe('7')
    expect(parseSupplierNumber('551',550)).toBe(null)
    expect(parseSupplierNumber('0',550)).toBe(null)
    expect(supplierConfirmsFinal('نعم أؤكد')).toBe(true)
  })
})
