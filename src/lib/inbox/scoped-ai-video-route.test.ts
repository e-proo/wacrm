import {beforeEach,describe,it,expect,vi} from 'vitest'
const h=vi.hoisted(()=>({role:vi.fn(),gate:vi.fn(),readGate:vi.fn(),policy:vi.fn(),context:vi.fn(),limit:vi.fn(),upload:vi.fn(),url:vi.fn(),from:vi.fn(),adminFrom:vi.fn(),safe:vi.fn(),update:vi.fn()}))
vi.mock('@/lib/auth/account',()=>({requireRole:h.role,UnauthorizedError:class extends Error{},ForbiddenError:class extends Error{}}))
vi.mock('@/lib/automations/admin-client',()=>({supabaseAdmin:()=>({from:h.adminFrom})}))
vi.mock('@/lib/inbox/provider-policy',()=>({evaluateInboxPolicy:h.policy,loadPolicyContext:h.context}))
vi.mock('@/lib/inbox/scoped-ui-gate',()=>({scopedInboxActionsEnabled:h.gate,scopedInboxEnabled:h.readGate}))
vi.mock('@/lib/rate-limit',()=>({checkRateLimit:h.limit,rateLimitResponse:()=>new Response(null,{status:429}),RATE_LIMITS:{send:{limit:30,windowMs:60000}}}))
vi.mock('@/lib/inbox/read-api',()=>({safeInboxMedia:h.safe}))
import {POST as upload} from '@/app/api/inbox/threads/[threadId]/video-upload/route'
import {GET as getAi,POST as postAi} from '@/app/api/inbox/threads/[threadId]/ai-control/route'
import {ForbiddenError} from '@/lib/auth/account'
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0')
const account=id(1),actor=id(2),thread=id(3),channel=id(4),connection=id(5),parent=id(6)
const params={params:Promise.resolve({threadId:thread})}
const expected={'x-wacrm-inbox-account':account,'x-wacrm-inbox-actor':actor}
const bytes=Uint8Array.from([0,0,0,12,102,116,121,112,0,0,0,0])
const video=(extra:Record<string,string>={},body=bytes)=>new Request('https://test.example/api/inbox/threads/'+thread+'/video-upload?channel_id='+channel+'&connection_id='+connection,{method:'POST',headers:{...expected,'content-type':'video/mp4','x-wacrm-upload-size':String(bytes.length),...extra},body:new Uint8Array(body)})
const ai=(body?:object,extra:Record<string,string>={})=>new Request('https://test.example/api/inbox/threads/'+thread+'/ai-control?channel_id='+channel,{method:body?'POST':'GET',headers:{...expected,'content-type':'application/json',...extra},...(body?{body:JSON.stringify(body)}:{})})
const paused={paused:false,expectedPaused:true,expectedHuman:true}
const conv={id:parent,ai_autoreply_disabled:true,assigned_agent_id:actor,ai_reply_count:3,ai_handoff_summary:null}
beforeEach(()=>{
 vi.resetAllMocks()
 h.gate.mockReturnValue(true);h.readGate.mockReturnValue(true);h.limit.mockReturnValue({success:true})
 h.role.mockResolvedValue({accountId:account,userId:actor,supabase:{from:h.from,storage:{from:()=>({upload:h.upload,getPublicUrl:h.url})}}})
 h.policy.mockResolvedValue({context:{can_operate:true},capabilities:{may_send_media:true,media_kinds:['video']}})
 h.context.mockResolvedValue({conversation_id:parent,membership_id:id(7),can_operate:true})
 h.upload.mockResolvedValue({error:null})
 h.url.mockReturnValue({data:{publicUrl:'https://test.example/storage/video'}})
 h.safe.mockReturnValue(true)
 const updated={eq:vi.fn().mockReturnThis(),is:vi.fn().mockReturnThis(),select:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:{id:parent},error:null})}
 h.update.mockReturnValue(updated)
 h.from.mockImplementation(table=>({select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:table==='conversations'?conv:{is_active:true,auto_reply_enabled:true,auto_reply_max_per_conversation:7},error:null}),update:h.update}))
 h.adminFrom.mockReturnValue({select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),count:1,error:null})
})
describe('scoped video relay',()=>{
 it('stages only exact bounded video bytes using the authenticated account storage',async()=>{
  const r=await upload(video(),params)
  expect(r.status).toBe(200)
  expect((await r.json()).path).toMatch(new RegExp('^account-'+account+'/'))
  expect(h.upload).toHaveBeenCalledOnce()
  expect(h.upload.mock.calls[0][2]).toMatchObject({contentType:'video/mp4',upsert:false})
  expect(h.policy).toHaveBeenCalledWith(expect.anything(),{accountId:account,userId:actor,threadId:thread,channelId:channel,connectionId:connection})
 })
 it('rejects role, disabled flags, mismatched account, origin, type, oversized or truncated body, and denied policy without upload',async()=>{
  h.role.mockRejectedValueOnce(new ForbiddenError())
  expect((await upload(video(),params)).status).toBe(403)
  h.gate.mockReturnValueOnce(false)
  expect((await upload(video(),params)).status).toBe(403)
  expect((await upload(video({'x-wacrm-inbox-account':id(8)}),params)).status).toBe(403)
  expect((await upload(video({origin:'https://foreign.example'}),params)).status).toBe(403)
  expect((await upload(video({'content-type':'video/webm'}),params)).status).toBe(415)
  expect((await upload(video({'x-wacrm-upload-size':String(16*1024*1024+1)}),params)).status).toBe(413)
  expect((await upload(video({},bytes.slice(0,8)),params)).status).toBe(400)
  expect((await upload(video({},new Uint8Array(bytes.length)),params)).status).toBe(415)
  h.policy.mockResolvedValueOnce(null)
  expect((await upload(video(),params)).status).toBe(409)
  expect(h.upload).not.toHaveBeenCalled()
 })
})
describe('scoped AI parent control',()=>{
 it('reads the real paused and assigned state without mutating it',async()=>{
  const r=await getAi(ai(),params)
  expect(r.status).toBe(200)
  expect(await r.json()).toMatchObject({enabled:true,paused:true,human_assigned:true,can_resume:true,thread_id:thread,channel_id:channel,read_only:true})
  expect(h.update).not.toHaveBeenCalled()
 })
 it('explicit resume uses the original parent transition',async()=>{
  const r=await postAi(ai(paused),params)
  expect(r.status).toBe(200)
  expect(h.update).toHaveBeenCalledExactlyOnceWith({ai_autoreply_disabled:false,assigned_agent_id:null,ai_reply_count:0,ai_handoff_summary:null})
 })
 it('rejects stale snapshot, wrong account, unavailable scope, disabled actions and multi-lane resume',async()=>{
  expect((await postAi(ai({...paused,expectedPaused:false}),params)).status).toBe(409)
  expect((await postAi(ai(paused,{'x-wacrm-inbox-account':id(8)}),params)).status).toBe(403)
  h.context.mockResolvedValueOnce(null)
  expect((await postAi(ai(paused),params)).status).toBe(404)
  h.gate.mockReturnValueOnce(false)
  expect((await postAi(ai(paused),params)).status).toBe(403)
  h.adminFrom.mockReturnValueOnce({select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),count:2,error:null})
  expect((await postAi(ai(paused),params)).status).toBe(409)
  expect(h.update).not.toHaveBeenCalled()
 })
})
