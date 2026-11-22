import {beforeEach,describe,expect,it,vi} from 'vitest'
const mock=vi.hoisted(()=>({role:vi.fn(),rpc:vi.fn(),test:vi.fn(),rate:vi.fn()}))
vi.mock('@/lib/auth/account',()=>({requireRole:mock.role,UnauthorizedError:class extends Error{},ForbiddenError:class extends Error{}}))
vi.mock('@/lib/automations/admin-client',()=>({supabaseAdmin:()=>({rpc:mock.rpc})}))
vi.mock('@/lib/whatsapp/transport/openwa/environment',()=>({isOpenWATestProject:mock.test}))
vi.mock('@/lib/rate-limit',()=>({checkRateLimit:mock.rate,rateLimitResponse:()=>new Response(null,{status:429})}))
import {GET} from './route'
import {INBOX_HEALTH_KEYS} from '@/lib/inbox/health-model'
const account='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222'
function req(headers:Record<string,string>={},query=''){return new Request('https://test.example/api/inbox/health'+query,{headers:{'x-wacrm-inbox-account':account,'x-wacrm-inbox-actor':actor,...headers}})}
beforeEach(()=>{vi.resetAllMocks();mock.role.mockResolvedValue({accountId:account,userId:actor});mock.test.mockReturnValue(true);mock.rate.mockReturnValue({success:true});vi.stubEnv('WACRM_INBOX_READ_API','test_only');mock.rpc.mockResolvedValue({data:{read_only:true,window:'24h',sampled_at:'2026-11-22T00:00:00Z',...Object.fromEntries(INBOX_HEALTH_KEYS.map(k=>[k,0]))},error:null})})
describe('SOF-80 restricted diagnostic route',()=>{
 it('returns account-scoped aggregate without native IDs or tokens',async()=>{
  const r=await GET(req())
  expect(r.status).toBe(200)
  expect(r.headers.get('Cache-Control')).toContain('no-store')
  expect(mock.role).toHaveBeenCalledWith('admin')
  expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('inbox_health_snapshot',{p_account:account,p_actor:actor})
  expect(JSON.stringify(await r.json())).not.toContain('native')
 })
 it('denies mismatched tenant/actor, extra query and disabled TEST before database access',async()=>{
  for(const response of [await GET(req({'x-wacrm-inbox-account':'wrong'})),await GET(req({},'?account_id=other'))])expect(response.status).toBeGreaterThanOrEqual(400)
  mock.test.mockReturnValue(false)
  expect((await GET(req())).status).toBe(403)
  expect(mock.rpc).not.toHaveBeenCalled()
 })
 it('never exposes database errors or unknown keys when RPC fails',async()=>{
  mock.rpc.mockResolvedValueOnce({error:{message:'secret SQL credential'}})
  const r=await GET(req())
  expect(r.status).toBe(503)
  expect(await r.text()).not.toContain('secret')
 })
})
