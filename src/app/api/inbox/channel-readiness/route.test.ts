import {beforeEach,describe,expect,it,vi} from 'vitest'
const mock=vi.hoisted(()=>({role:vi.fn(),rpc:vi.fn(),test:vi.fn(),rate:vi.fn()}))
vi.mock('@/lib/auth/account',()=>({requireRole:mock.role,UnauthorizedError:class extends Error{},ForbiddenError:class extends Error{}}))
vi.mock('@/lib/automations/admin-client',()=>({supabaseAdmin:()=>({rpc:mock.rpc})}))
vi.mock('@/lib/whatsapp/transport/openwa/environment',()=>({isOpenWATestProject:mock.test}))
vi.mock('@/lib/rate-limit',()=>({checkRateLimit:mock.rate,rateLimitResponse:()=>new Response(null,{status:429})}))
import {GET,POST} from './route'
const account='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222',connection='33333333-3333-4333-8333-333333333333',member='44444444-4444-4444-8444-444444444444'
function req(query='',headers:Record<string,string>={},body?:unknown){return new Request('https://test.example/api/inbox/channel-readiness'+query,{method:body===undefined?'GET':'POST',headers:{'x-wacrm-inbox-account':account,'x-wacrm-inbox-actor':actor,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)})}
const revoke={connectionId:connection,membershipId:member,wasPrimary:true,confirmMaintenance:true}
beforeEach(()=>{vi.resetAllMocks();mock.role.mockResolvedValue({accountId:account,userId:actor});mock.test.mockReturnValue(true);mock.rate.mockReturnValue({success:true});vi.stubEnv('WACRM_INBOX_READ_API','test_only');vi.stubEnv('WACRM_INBOX_SCOPED_UI','test_only');vi.stubEnv('WACRM_INBOX_SHADOW_ENROLLMENT','true');vi.stubEnv('WACRM_INBOX_CANONICAL_INGRESS','off');vi.stubEnv('WACRM_INBOX_ACTIONS','off');mock.rpc.mockResolvedValue({data:{rows:[]},error:null})})
describe('FIX-02 readiness API',()=>{
 it('reads bounded admin projection with server-derived account',async()=>{
  const r=await GET(req('?after='+connection));expect(r.status).toBe(200)
  expect(r.headers.get('Cache-Control')).toContain('no-store')
  expect(mock.role).toHaveBeenCalledWith('admin')
  expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('inbox_admin_channel_readiness',{p_account:account,p_actor:actor,p_after:connection,p_limit:20})
  expect(await r.json()).toEqual({read_only:true,items:[],next_after:null,gates:{shadow:true,canonical:false,actions:false}})
 })
 it('denies foreign context, invalid query or non-TEST before calling RPC',async()=>{
  expect((await GET(req('',{'x-wacrm-inbox-account':'foreign'}))).status).toBe(403)
  expect((await GET(req('?account_id=foreign'))).status).toBe(400)
  expect((await GET(req('?after=bad'))).status).toBe(400)
  mock.test.mockReturnValue(false)
  expect((await GET(req())).status).toBe(403);expect(mock.rpc).not.toHaveBeenCalled()
 })
 it('requires explicit maintenance confirmation and both runtime flags off',async()=>{
  expect((await POST(req('',{}, {...revoke,confirmMaintenance:false}))).status).toBe(400)
  expect((await POST(req('',{}, {...revoke,accountId:'foreign'}))).status).toBe(400)
  vi.stubEnv('WACRM_INBOX_CANONICAL_INGRESS','test_only')
  expect((await POST(req('',{},revoke))).status).toBe(403)
  vi.stubEnv('WACRM_INBOX_CANONICAL_INGRESS','off');vi.stubEnv('WACRM_INBOX_ACTIONS','test_only')
  expect((await POST(req('',{},revoke))).status).toBe(403);expect(mock.rpc).not.toHaveBeenCalled()
 })
 it('passes exact epoch and rejects stale or busy revocation without leaking internal errors',async()=>{
  mock.rpc.mockResolvedValueOnce({data:{state:'revoked'},error:null})
  const r=await POST(req('',{},revoke));expect(await r.json()).toEqual({state:'revoked'})
  expect(mock.rpc).toHaveBeenCalledWith('inbox_admin_revoke_openwa_enrollment',{p_account:account,p_actor:actor,p_connection:connection,p_membership:member,p_was_primary:true,p_request:expect.any(String)})
  mock.rpc.mockResolvedValueOnce({data:{state:'busy'},error:null});expect((await POST(req('',{},revoke))).status).toBe(409)
  mock.rpc.mockResolvedValueOnce({data:{state:'conflict'},error:null});expect((await POST(req('',{},revoke))).status).toBe(409)
  mock.rpc.mockResolvedValueOnce({error:{message:'private credential'}});const e=await POST(req('',{},revoke));expect(e.status).toBe(503);expect(await e.text()).not.toContain('private')
 })
})
