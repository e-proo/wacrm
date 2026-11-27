import {beforeEach,describe,expect,it,vi} from 'vitest'
const mock=vi.hoisted(()=>({role:vi.fn(),rpc:vi.fn(),test:vi.fn(),rate:vi.fn()}))
vi.mock('@/lib/auth/account',()=>({requireRole:mock.role,UnauthorizedError:class extends Error{},ForbiddenError:class extends Error{}}))
vi.mock('@/lib/automations/admin-client',()=>({supabaseAdmin:()=>({rpc:mock.rpc})}))
vi.mock('@/lib/whatsapp/transport/openwa/environment',()=>({isOpenWATestProject:mock.test}))
vi.mock('@/lib/rate-limit',()=>({checkRateLimit:mock.rate,rateLimitResponse:()=>new Response(null,{status:429})}))
import {GET,POST} from './route'
const account='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222',receipt='33333333-3333-4333-8333-333333333333',requestId='44444444-4444-4444-8444-444444444444'
function req(query='',headers:Record<string,string>={},body?:unknown){return new Request('https://test.example/api/inbox/intake-review'+query,{method:body===undefined?'GET':'POST',headers:{'x-wacrm-inbox-account':account,'x-wacrm-inbox-actor':actor,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)})}
const close={receiptId:receipt,requestId,action:'close_unverified',confirmMaintenance:true}
beforeEach(()=>{vi.resetAllMocks();mock.role.mockResolvedValue({accountId:account,userId:actor});mock.test.mockReturnValue(true);mock.rate.mockReturnValue({success:true});vi.stubEnv('WACRM_INBOX_READ_API','test_only');vi.stubEnv('WACRM_INBOX_SCOPED_UI','test_only');vi.stubEnv('WACRM_INBOX_SHADOW_ENROLLMENT','true');vi.stubEnv('WACRM_INBOX_CANONICAL_INGRESS','off');vi.stubEnv('WACRM_INBOX_ACTIONS','off');vi.stubEnv('WACRM_OPENWA_DURABLE_INTAKE','off');mock.rpc.mockResolvedValue({data:{rows:[]},error:null})})
describe('FIX-03 restricted review API',()=>{
 it('uses server account and bounded closed/open page',async()=>{
  const r=await GET(req('?closed=true&after='+receipt));expect(r.status).toBe(200)
  expect(r.headers.get('Cache-Control')).toContain('no-store')
  expect(mock.role).toHaveBeenCalledWith('admin')
  expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('inbox_admin_intake_review_page',{p_account:account,p_actor:actor,p_closed:true,p_after:receipt,p_limit:20})
  expect(await r.json()).toEqual({read_only:true,items:[],next_after:null,maintenance_ready:true,closed:true})
 })
 it('rejects foreign context, bad pagination and non-TEST without RPC',async()=>{
  expect((await GET(req('',{'x-wacrm-inbox-actor':'foreign'}))).status).toBe(403)
  expect((await GET(req('?account_id=foreign'))).status).toBe(400)
  expect((await GET(req('?closed=true&closed=false'))).status).toBe(400)
  mock.test.mockReturnValue(false)
  expect((await GET(req())).status).toBe(403);expect(mock.rpc).not.toHaveBeenCalled()
 })
 it('rejects maintenance gate and arbitrary identity or action before writes',async()=>{
  expect((await POST(req('',{}, {...close,confirmMaintenance:false}))).status).toBe(400)
  expect((await POST(req('',{}, {...close,action:'replay'}))).status).toBe(400)
  expect((await POST(req('',{}, {...close,phone:'foreign'}))).status).toBe(400)
  vi.stubEnv('WACRM_INBOX_CANONICAL_INGRESS','test_only')
  expect((await POST(req('',{},close))).status).toBe(403)
  vi.stubEnv('WACRM_INBOX_CANONICAL_INGRESS','off');vi.stubEnv('WACRM_INBOX_ACTIONS','test_only')
  expect((await POST(req('',{},close))).status).toBe(403)
  vi.stubEnv('WACRM_INBOX_ACTIONS','off');vi.stubEnv('WACRM_OPENWA_DURABLE_INTAKE','test_only')
  expect((await POST(req('',{},close))).status).toBe(403);expect(mock.rpc).not.toHaveBeenCalled()
 })
 it('uses same request key for retries and only reports matching audited outcome',async()=>{
  mock.rpc.mockResolvedValueOnce({data:{state:'settled',outcome:'closed_unverified'},error:null})
  const r=await POST(req('',{},close));expect(await r.json()).toEqual({state:'settled',outcome:'closed_unverified'})
  expect(mock.rpc).toHaveBeenCalledWith('inbox_admin_settle_intake_review',{p_account:account,p_actor:actor,p_receipt:receipt,p_action:'close_unverified',p_request:requestId})
  mock.rpc.mockResolvedValueOnce({data:{state:'busy'},error:null});expect((await POST(req('',{},close))).status).toBe(409)
  mock.rpc.mockResolvedValueOnce({data:{state:'not_eligible'},error:null});expect((await POST(req('',{},close))).status).toBe(409)
  mock.rpc.mockResolvedValueOnce({data:{state:'settled',outcome:'restored_history'},error:null});expect((await POST(req('',{},close))).status).toBe(503)
  mock.rpc.mockResolvedValueOnce({error:{message:'private credential'}});const e=await POST(req('',{},close));expect(e.status).toBe(503);expect(await e.text()).not.toContain('private')
 })
})
