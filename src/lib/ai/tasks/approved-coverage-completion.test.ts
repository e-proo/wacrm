import { describe, expect, it, vi } from 'vitest'
import { finalizeTaskAfterApprovedCoverageOffer } from './approved-coverage-completion'

const accountId='33333333-3333-4333-8333-333333333333'
const taskId='11111111-1111-4111-8111-111111111111'
const targetId='22222222-2222-4222-8222-222222222222'
const requestId='44444444-4444-4444-8444-444444444444'
const payload={
  source_task_id:taskId,source_task_target_id:targetId,
  source_coverage_request_id:requestId,
}
function mockedDb(options?:{taskStatus?:string,targetStatus?:string,
  requestId?:string,taskType?:string}){
  const from=vi.fn((table:string)=>{
    const conditions:Record<string,unknown>={}
    const q={
      select:()=>q,
      eq:(k:string,v:unknown)=>{conditions[k]=v;return q},
      maybeSingle:async()=>{
        if(conditions.account_id!==accountId) return {data:null,error:null}
        if(table==='ai_agent_tasks') return {
          data:{id:taskId,task_type:options?.taskType??'coverage.sourcing',
            status:options?.taskStatus??'running',
            task_context:{coverageRequestId:options?.requestId??requestId}},
          error:null,
        }
        if(table==='ai_agent_task_targets') return {
          data:{id:targetId,status:options?.targetStatus??'completed'},
          error:null,
        }
        throw new Error('Unexpected table '+table)
      },
    }
    return q
  })
  return { db:{from} as never, from }
}
const decision={finalized:true,status:'completed' as const,reason:'supplier_offer_executed'}
describe('post-approval Coverage supplier task completion',()=>{
  it('re-evaluates the exact account-scoped running sourcing task once the supplier target is completed',async()=>{
    const {db,from}=mockedDb()
    const evaluate=vi.fn().mockResolvedValue(decision)
    const value=await finalizeTaskAfterApprovedCoverageOffer({
      db,accountId,actionKey:'coverage.offer.create',
      targetType:'coverage_offer',proposedPayload:payload,evaluate,
    })
    expect(value).toEqual(decision)
    expect(evaluate).toHaveBeenCalledExactlyOnceWith(taskId)
    expect(from).toHaveBeenCalledWith('ai_agent_tasks')
    expect(from).toHaveBeenCalledWith('ai_agent_task_targets')
  })
  it('does not finalize counteroffer review or unrelated ordinary approvals',async()=>{
    const {db,from}=mockedDb()
    const evaluate=vi.fn()
    for(const actionKey of ['coverage.supplier_counteroffer.review','coverage.request.create']) {
      expect(await finalizeTaskAfterApprovedCoverageOffer({
        db,accountId,actionKey,targetType:'coverage_offer',proposedPayload:payload,evaluate,
      })).toBeNull()
    }
    expect(from).not.toHaveBeenCalled()
    expect(evaluate).not.toHaveBeenCalled()
  })
  it('never finalizes a task from another request or an uncompleted target',async()=>{
    for(const options of [{requestId:'55555555-5555-4555-8555-555555555555'},
      {targetStatus:'replied'},{taskStatus:'cancelled'},{taskType:'service.promotion'}]){
      const {db}=mockedDb(options)
      const evaluate=vi.fn()
      const result=await finalizeTaskAfterApprovedCoverageOffer({
        db,accountId,actionKey:'coverage.offer.create',targetType:'coverage_offer',
        proposedPayload:payload,evaluate,
      })
      expect(result).toBeNull()
      expect(evaluate).not.toHaveBeenCalled()
    }
  })
  it('ignores malformed source IDs and never invokes the evaluator',async()=>{
    const {db,from}=mockedDb()
    const evaluate=vi.fn()
    const result=await finalizeTaskAfterApprovedCoverageOffer({
      db,accountId,actionKey:'coverage.offer.create',targetType:'coverage_offer',
      proposedPayload:{...payload,source_task_id:'other-account'},evaluate,
    })
    expect(result).toBeNull()
    expect(from).not.toHaveBeenCalled()
    expect(evaluate).not.toHaveBeenCalled()
  })
  it('preserves the registered policy decision when other targets remain actionable',async()=>{
    const {db}=mockedDb()
    const evaluate=vi.fn().mockResolvedValue({
      status:'continue',reason:'coverage_targets_still_actionable',finalized:false,
    })
    expect(await finalizeTaskAfterApprovedCoverageOffer({
      db,accountId,actionKey:'coverage.offer.create',
      targetType:'coverage_offer',proposedPayload:payload,evaluate,
    })).toMatchObject({status:'continue',finalized:false})
  })
})
