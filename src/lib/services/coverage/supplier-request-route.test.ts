import { describe, expect, it, vi } from 'vitest'
import {
  loadSupplierCoverageRoute,
  assertSupplierRouteMatchesAttributes,
  describeSupplierCoverageRoute,
  supplierNotesConflictWithRoute,
} from './supplier-request-route'
const IBB='00000000-0000-4000-8000-000000000001'
const HAD='00000000-0000-4000-8000-000000000002'
const SANA='00000000-0000-4000-8000-000000000003'
const attrs={coverage_scope:'domestic',coverage_country:null,
  pay_region_id:IBB,receive_region_id:HAD,pay_method:'any',receive_method:'any'}
const route={requesterPayRegionId:IBB,requesterPayRegion:'إب',
  requesterPayMethod:'أي طريقة متاحة',requesterReceiveRegionId:HAD,
  requesterReceiveRegion:'حضرموت',requesterReceiveMethod:'أي طريقة متاحة',
  scope:'domestic' as const,country:null}
const regions=[{id:IBB,name:'إب'},{id:HAD,name:'حضرموت'},{id:SANA,name:'صنعاء'}]

describe('frozen Coverage supplier route contract',()=>{
  it('resolves only account-scoped request legs and displays both parties with opposite direction',async()=>{
    const from=vi.fn((_table:string)=>({
      select(){return this},eq(){return this},in(){return this},
      limit:async()=>({data:regions.slice(0,2),error:null}),
    }))
    const resolved=await loadSupplierCoverageRoute({from} as never,'account',attrs)
    expect(resolved).toEqual(route)
    expect(from).toHaveBeenCalledWith('coverage_regions')
    const summary=describeSupplierCoverageRoute(resolved)
    expect(summary).toContain('طالب التغطية يدفع في: إب')
    expect(summary).toContain('طالب التغطية يستلم في: حضرموت')
    expect(summary).toContain('تسلّم التغطية في حضرموت')
    expect(summary).toContain('تستلم المقابل في إب')
    expect(()=>assertSupplierRouteMatchesAttributes(resolved,attrs)).not.toThrow()
    expect(()=>assertSupplierRouteMatchesAttributes(resolved,
      {...attrs,pay_region_id:HAD})).toThrow('SNAPSHOT_CONFLICT')
  })
  it('never sends amount-only if region identity is missing or unresolved',async()=>{
    const from=()=>({
      select(){return this},eq(){return this},in(){return this},
      limit:async()=>({data:[regions[0]],error:null}),
    })
    await expect(loadSupplierCoverageRoute({from} as never,'account',attrs))
      .rejects.toThrow('REGION_UNRESOLVED')
    await expect(loadSupplierCoverageRoute({from} as never,'account',{
      ...attrs,receive_region_id:null,
    })).rejects.toThrow('ROUTE_INCOMPLETE')
  })
  it('blocks the actual TEST discrepancy (Mukalla delivery, Sana’a receipt)',()=>{
    expect(supplierNotesConflictWithRoute(
      'سأسلم في المكلاء واريد ان استلم في صنعاء. طريقة الدفع مسموح ومتوفر اي طريقه',
      route,regions)).toBe(true)
    expect(supplierNotesConflictWithRoute(
      'متاح خلال اليوم، لا توجد شروط إضافية',route,regions)).toBe(false)
    expect(supplierNotesConflictWithRoute(
      'ممكن الدفع في حضرموت والاستلام في إب',route,regions)).toBe(false)
  })
})
