import {beforeEach,describe,expect,it,vi} from 'vitest'

const mocked=vi.hoisted(()=>({db:null as unknown,from:vi.fn()}))
vi.mock('@/lib/ai/admin-client',()=>({supabaseAdmin:()=>mocked.db}))
import {COVERAGE_CHANGE_EXECUTORS} from './change-executors'

const accountId='00000000-0000-4000-8000-000000000001'
const changeId='00000000-0000-4000-8000-000000000002'
const taskId='00000000-0000-4000-8000-000000000003'
const targetId='00000000-0000-4000-8000-000000000004'
const requestId='00000000-0000-4000-8000-000000000005'
const supplierId='00000000-0000-4000-8000-000000000006'
const convId='00000000-0000-4000-8000-000000000007'
const serviceId='00000000-0000-4000-8000-000000000008'
const terms='أسلم في حضرموت، لكن أستلم في إب بدل صنعاء.'
const payload={
  source_task_id:taskId,source_task_target_id:targetId,source_coverage_request_id:requestId,
  contact_id:supplierId,conversation_id:convId,service_id:serviceId,total_amount:'500',
  commission_per_thousand:'7',currency:'SAR',
  supplier_terms:{details:terms,route_match:false},
}
const input={
  id:changeId,actionKey:'coverage.supplier_counteroffer.review',actionVersion:1,
  targetType:'coverage_supplier_quote',targetId:null,intent:'create',
  proposedPayload:payload,expectedVersion:null,contentDigest:'digest',claimToken:'token',
}
let targetContact=supplierId
beforeEach(()=>{
  mocked.from.mockClear()
  targetContact=supplierId
  mocked.db={
    from:(table:string)=>{
      mocked.from(table)
      const chain={
        select:()=>chain,eq:()=>chain,in:()=>Promise.resolve({error:null}),
        update:()=>chain,
        maybeSingle:async()=>{
          const rows:Record<string,unknown>={
            ai_agent_tasks:{id:taskId,task_type:'coverage.sourcing',task_context:{
              coverageRequestId:requestId},status:'running'},
            ai_agent_task_targets:{id:targetId,contact_id:targetContact,conversation_id:convId,status:'replied'},
            ai_agent_coverage_supplier_negotiations:{stage:'submitted',route_different:true,
              route_confirmed:false,offered_amount:'500.0000',commission_per_thousand:'7.0000',
              supplier_details:terms,change_request_id:changeId},
            coverage_requests:{id:requestId,service_id:serviceId,currency:'SAR',attributes:{}},
          }
          return {data:rows[table]??null,error:null}
        },
      }
      return chain
    },
  }
})
describe('different supplier proposal administrative review is NOT an executable matching offer',()=>{
  const executor=COVERAGE_CHANGE_EXECUTORS.find(e=>e.actionKey==='coverage.supplier_counteroffer.review')!.executor
  it('records review and defers to a human without creating a Coverage Offer',async()=>{
    const result=await executor({accountId,changeRequestId:changeId,actorUserId:null},input)
    expect(result).toMatchObject({requires_manual_followup:true,created_offer:false})
    expect(mocked.from).not.toHaveBeenCalledWith('coverage_offers')
    expect(mocked.from).not.toHaveBeenCalledWith('coverage_matches')
    expect(mocked.from).toHaveBeenCalledWith('ai_agent_task_targets')
  })
  it('rejects a forged or cross-contact target and does not write an offer',async()=>{
    targetContact='00000000-0000-4000-8000-000000000009'
    await expect(executor({accountId,changeRequestId:changeId,actorUserId:null},input))
      .rejects.toThrow('not bound to the exact supplier')
    expect(mocked.from).not.toHaveBeenCalledWith('coverage_offers')
  })
  it('rejects a claimed matching quote disguised as a counteroffer',async()=>{
    await expect(executor({accountId,changeRequestId:changeId,actorUserId:null},
      {...input,proposedPayload:{...payload,supplier_terms:{details:terms,route_match:true}}}))
      .rejects.toThrow('Counteroffer review requires')
    expect(mocked.from).not.toHaveBeenCalled()
  })
})
