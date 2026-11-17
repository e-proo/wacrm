import { describe, expect, it } from 'vitest'
import { extractSupplierQuote } from './supplier-quote-extraction'
const facts={
  remainingAmount:'550',
  route: {
    requesterPayRegionId:'00000000-0000-4000-8000-000000000001',
    requesterPayRegion:'صنعاء',requesterPayMethod:'أي طريقة متاحة',
    requesterReceiveRegionId:'00000000-0000-4000-8000-000000000002',
    requesterReceiveRegion:'حضرموت',requesterReceiveMethod:'أي طريقة متاحة',
    scope:'domestic' as const,country:null,
  },
  knownRegions:[
    {id:'00000000-0000-4000-8000-000000000001',name:'صنعاء'},
    {id:'00000000-0000-4000-8000-000000000002',name:'حضرموت'},
    {id:'00000000-0000-4000-8000-000000000003',name:'إب'},
  ],
}
describe('natural supplier quote extraction',()=>{
  it('extracts the actual full-message acceptance without round-trips or confusing commission with amount',()=>{
    const q=extractSupplierQuote('نعم واستطيع توفير المبلغ كامل 550 واريد عموله 7 لكل 1000 وطريقة الدفع والاستلام اي طريقة متوفر عادي اكد على العرض',facts)
    expect(q).toMatchObject({available:true,routeAssent:true,routeDifference:false,
      amount:'550',commission:'7',finalConsent:true})
  })
  it('accepts natural route assent not only exact phrase',()=>{
    expect(extractSupplierQuote('نعم المسار مطابق',facts).routeAssent).toBe(true)
  })
  it('recognizes counteroffers as different without inventing the requested route',()=>{
    const q=extractSupplierQuote('نعم اوفر 500 ريال عمولتي 9 لكل 1000 لكن استلم في إب بدل صنعاء، اكد العرض',facts)
    expect(q).toMatchObject({amount:'500',commission:'9',routeDifference:true,finalConsent:true})
  })
  it('does not confuse the full 550 SAR request with a smaller 300 SAR supplier counterquote',()=>{
    const q=extractSupplierQuote(
      'الطلب 550 ريال، وأنا أقدر أوفر 300 ريال وعمولتي 7 لكل 1000، أكد العرض',
      facts)
    expect(q.amount).toBe('300')
    expect(q.commission).toBe('7')
    expect(q.finalConsent).toBe(true)
  })
  it('detects reversed settlement legs as a counteroffer rather than exact match',()=>{
    const q=extractSupplierQuote(
      'نعم أوفر 550 ريال عمولة 7 لكل 1000 لكن أسلم في صنعاء واستلم في حضرموت',
      facts)
    expect(q.routeDifference).toBe(true)
    expect(q.routeAssent).toBe(false)
  })

  it('avoids interpreting only a per-1000 commission as offered amount',()=>{
    const q=extractSupplierQuote('عمولة 7 لكل 1000',facts)
    expect(q.commission).toBe('7')
    expect(q.amount).toBe(null)
  })
  it('does not infer a price from a message with two unlabelled numbers',()=>{
    expect(extractSupplierQuote('100 و 200',facts).amount).toBe(null)
  })
})
