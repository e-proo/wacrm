import {beforeEach,describe,expect,it,vi} from 'vitest'
const h=vi.hoisted(()=>({process:vi.fn(),open:vi.fn(),gate:vi.fn(),canonical:vi.fn()}))
vi.mock('./webhook-processing',()=>({createOpenWAWebhookDb:vi.fn(),processReservedOpenWAWebhook:h.process}))
vi.mock('@/lib/inbox/canonical-ingress',()=>({canonicalInboxTestMode:h.canonical}))
vi.mock('./durable-intake',()=>({durableOpenWAIntakeEnabled:h.gate,readIntakeClaim:(v:unknown)=>v,openIntake:h.open}))
import {processOpenWAIntakeTick} from './intake-worker'
const claim={state:'claimed',id:'fixture',token:'lease',account_id:'account',connection_id:'connection',canonical:true}
beforeEach(()=>{vi.resetAllMocks();h.gate.mockReturnValue(true);h.canonical.mockReturnValue(true);h.open.mockReturnValue({eventId:'evt',event:'message'});h.process.mockResolvedValue(new Response(null,{status:202}))})
describe('durable signed intake worker',()=>{
 it('never invokes work while disabled or idle',async()=>{
  const rpc=vi.fn().mockResolvedValue({data:{state:'idle'},error:null})
  h.gate.mockReturnValueOnce(false)
  expect((await processOpenWAIntakeTick({rpc} as never)).disabled).toBe(true)
  expect(rpc).not.toHaveBeenCalled()
  expect((await processOpenWAIntakeTick({rpc} as never)).claimed).toBe(0)
  expect(h.process).not.toHaveBeenCalled()
 })
 it('reuses one business pipeline then settles by immutable receipt lease',async()=>{
  const rpc=vi.fn().mockResolvedValueOnce({data:claim,error:null}).mockResolvedValueOnce({data:true,error:null}).mockResolvedValueOnce({data:'completed',error:null})
  expect(await processOpenWAIntakeTick({rpc} as never)).toEqual({claimed:1,completed:1,review:0,disabled:false})
  expect(h.process).toHaveBeenCalledExactlyOnceWith({rpc},{accountId:'account',connectionId:'connection',envelope:{eventId:'evt',event:'message'},processingToken:'lease'},true,true)
  expect(rpc).toHaveBeenLastCalledWith('openwa_finish_signed_intake',{p_id:'fixture',p_token:'lease',p_reason:null})
 })
 it('holds uncertainty without another processing call',async()=>{
  const rpc=vi.fn().mockResolvedValueOnce({data:claim,error:null}).mockResolvedValueOnce({data:true,error:null}).mockResolvedValueOnce({data:'review',error:null})
  h.process.mockRejectedValueOnce(Error('private provider details'))
  expect((await processOpenWAIntakeTick({rpc} as never)).review).toBe(1)
  expect(h.process).toHaveBeenCalledTimes(1)
  expect(rpc).toHaveBeenLastCalledWith('openwa_finish_signed_intake',{p_id:'fixture',p_token:'lease',p_reason:'processing_uncertain'})
 })
 it('holds a damaged or wrong-mode envelope without processing',async()=>{
  const rpc=vi.fn().mockResolvedValueOnce({data:{...claim,canonical:false},error:null}).mockResolvedValueOnce({data:'review',error:null})
  expect((await processOpenWAIntakeTick({rpc} as never)).review).toBe(1)
  expect(h.process).not.toHaveBeenCalled()
  expect(rpc).toHaveBeenLastCalledWith('openwa_finish_signed_intake',{p_id:'fixture',p_token:'lease',p_reason:'payload_unavailable'})
 })
})

it('does not process a changed route even after a valid queue claim',async()=>{
 const rpc=vi.fn().mockResolvedValueOnce({data:claim,error:null}).mockResolvedValueOnce({data:false,error:null}).mockResolvedValueOnce({data:'review',error:null})
 expect((await processOpenWAIntakeTick({rpc} as never)).review).toBe(1)
 expect(h.process).not.toHaveBeenCalled()
 expect(rpc).toHaveBeenLastCalledWith('openwa_finish_signed_intake',{p_id:'fixture',p_token:'lease',p_reason:'processing_uncertain'})
})

it('recognizes session lifecycle aliases before applying the ready-session fence',async()=>{
 h.open.mockReturnValueOnce({eventId:'evt',event:'session status'})
 const rpc=vi.fn().mockResolvedValueOnce({data:claim,error:null}).mockResolvedValueOnce({data:true,error:null}).mockResolvedValueOnce({data:'completed',error:null})
 expect((await processOpenWAIntakeTick({rpc} as never)).completed).toBe(1)
 expect(rpc).toHaveBeenCalledWith('openwa_check_claimed_intake',{p_id:'fixture',p_token:'lease',p_canonical:true,p_lifecycle:true})
})

describe('FIX-06 heartbeat',()=>{
 it('renews an in-flight long handler, never dispatches twice, and stops on completion',async()=>{
  vi.useFakeTimers()
  try{
   let complete!:(r:Response)=>void
   h.process.mockReturnValueOnce(new Promise<Response>(resolve=>{complete=resolve}))
   const renewal=vi.fn().mockResolvedValue({data:true,error:null})
   const rpc=vi.fn().mockImplementation((name:string)=>{
    if(name==='openwa_claim_signed_intake')return Promise.resolve({data:claim,error:null})
    if(name==='openwa_check_claimed_intake')return Promise.resolve({data:true,error:null})
    if(name==='openwa_renew_signed_intake')return {abortSignal:renewal}
    return Promise.resolve({data:'completed',error:null})
   })
   const tick=processOpenWAIntakeTick({rpc} as never)
   await vi.advanceTimersByTimeAsync(110_000)
   expect(renewal).toHaveBeenCalledTimes(5)
   expect(h.process).toHaveBeenCalledTimes(1)
   expect(rpc).toHaveBeenCalledWith('openwa_renew_signed_intake',{p_id:'fixture',p_token:'lease',p_canonical:true,p_lifecycle:false})
   complete(new Response(null,{status:202}))
   expect((await tick).completed).toBe(1)
   await vi.advanceTimersByTimeAsync(60_000)
   expect(renewal).toHaveBeenCalledTimes(5)
  }finally{vi.useRealTimers()}
 })
 it('stops renewals on denial and leaves the single business invocation for ledger reconciliation',async()=>{
  vi.useFakeTimers()
  try{
   let complete!:(r:Response)=>void
   h.process.mockReturnValueOnce(new Promise<Response>(resolve=>{complete=resolve}))
   const renewal=vi.fn().mockResolvedValue({data:false,error:null})
   const rpc=vi.fn().mockImplementation((name:string)=>{
    if(name==='openwa_claim_signed_intake')return Promise.resolve({data:claim,error:null})
    if(name==='openwa_check_claimed_intake')return Promise.resolve({data:true,error:null})
    if(name==='openwa_renew_signed_intake')return {abortSignal:renewal}
    return Promise.resolve({data:'review',error:null})
   })
   const tick=processOpenWAIntakeTick({rpc} as never)
   await vi.advanceTimersByTimeAsync(110_000)
   expect(renewal).toHaveBeenCalledTimes(1)
   complete(new Response(null,{status:503}))
   expect((await tick).review).toBe(1)
   expect(h.process).toHaveBeenCalledTimes(1)
  }finally{vi.useRealTimers()}
 })
})
