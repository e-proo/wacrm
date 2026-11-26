import {beforeEach,describe,expect,it,vi} from 'vitest'
const h=vi.hoisted(()=>({process:vi.fn(),open:vi.fn(),gate:vi.fn(),canonical:vi.fn()}))
vi.mock('./webhook-processing',()=>({createOpenWAWebhookDb:vi.fn(),processReservedOpenWAWebhook:h.process}))
vi.mock('@/lib/inbox/canonical-ingress',()=>({canonicalInboxTestMode:h.canonical}))
vi.mock('./durable-intake',()=>({durableOpenWAIntakeEnabled:h.gate,readIntakeClaim:(v:unknown)=>v,openIntake:h.open}))
import {processOpenWAIntakeTick} from './intake-worker'
const claim={state:'claimed',id:'fixture',token:'lease',account_id:'account',connection_id:'connection',canonical:true}
beforeEach(()=>{vi.resetAllMocks();h.gate.mockReturnValue(true);h.canonical.mockReturnValue(true);h.open.mockReturnValue({eventId:'evt'});h.process.mockResolvedValue(new Response(null,{status:202}))})
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
  const rpc=vi.fn().mockResolvedValueOnce({data:claim,error:null}).mockResolvedValueOnce({data:'completed',error:null})
  expect(await processOpenWAIntakeTick({rpc} as never)).toEqual({claimed:1,completed:1,review:0,disabled:false})
  expect(h.process).toHaveBeenCalledExactlyOnceWith({rpc},{accountId:'account',connectionId:'connection',envelope:{eventId:'evt'},processingToken:'lease'},true)
  expect(rpc).toHaveBeenLastCalledWith('openwa_finish_signed_intake',{p_id:'fixture',p_token:'lease',p_reason:null})
 })
 it('holds uncertainty without another processing call',async()=>{
  const rpc=vi.fn().mockResolvedValueOnce({data:claim,error:null}).mockResolvedValueOnce({data:'review',error:null})
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
