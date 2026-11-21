import { describe,it,expect,vi,beforeEach,afterEach } from 'vitest'
const h=vi.hoisted(()=>({role:vi.fn(),rpc:vi.fn(),gate:vi.fn()}))
vi.mock('@/lib/auth/account',()=>({requireRole:h.role,UnauthorizedError:class extends Error{},ForbiddenError:class extends Error{}}))
vi.mock('@/lib/automations/admin-client',()=>({supabaseAdmin:()=>({rpc:h.rpc})}))
vi.mock('./scoped-ui-gate',()=>({scopedInboxEnabled:h.gate}))
import { acknowledgeScopedThread } from './scoped-read-action'
import { signReadSnapshot,verifyReadSnapshot,validWatermark } from './read-snapshot'
import { ForbiddenError } from '@/lib/auth/account'
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',c='33333333-3333-4333-8333-333333333333',d='44444444-4444-4444-8444-444444444444'
const scope={accountId:a,userId:b,threadId:c,channelId:d,seen:'9007199254740993'}
const key='test-key'
const req=(token:unknown,headers:Record<string,string>={})=>new Request('https://test.example/api/inbox/threads/'+c+'/read',{method:'POST',headers:{'content-type':'application/json','x-wacrm-inbox-account':a,'x-wacrm-inbox-actor':b,...headers},body:JSON.stringify({token})})
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY',key);h.role.mockResolvedValue({accountId:a,userId:b,role:'agent'});h.gate.mockReturnValue(true);h.rpc.mockResolvedValue({data:{thread_id:c,channel_id:d,read_watermark:scope.seen},error:null})})
afterEach(()=>vi.unstubAllEnvs())
describe('scoped local read boundary',()=>{
 it('signs precision-safe snapshots, expires and rejects tampering or cross-thread/account/actor replay',()=>{
  const token=signReadSnapshot(scope,key,1000)
  expect(verifyReadSnapshot(token,scope,key,1001)).toEqual(scope)
  for(const wrong of [{...scope,accountId:d},{...scope,userId:d},{...scope,threadId:d}])expect(verifyReadSnapshot(token,wrong,key,1001)).toBeNull()
  expect(verifyReadSnapshot(token+'x',scope,key,1001)).toBeNull()
  expect(verifyReadSnapshot(token,scope,key,121000)).toBeNull()
  expect(validWatermark('9223372036854775808')).toBe(false)
  expect(validWatermark(scope.seen)).toBe(true)
 })
 it('calls only the local exact read RPC with the observed highwater',async()=>{
  const r=await acknowledgeScopedThread(req(signReadSnapshot(scope,key)),c)
  expect(r.status).toBe(200)
  expect(h.role).toHaveBeenCalledWith('agent')
  expect(h.rpc).toHaveBeenCalledExactlyOnceWith('inbox_mark_thread_read',{p_account:a,p_actor:b,p_thread:c,p_channel:d,p_seen:scope.seen})
 })
 it('fails closed for account mismatch, another thread, cross-site origin, viewer or disabled flag',async()=>{
  const token=signReadSnapshot(scope,key)
  expect((await acknowledgeScopedThread(req(token,{'x-wacrm-inbox-account':d}),c)).status).toBe(403)
  expect((await acknowledgeScopedThread(req(token),d)).status).toBe(400)
  expect((await acknowledgeScopedThread(req(token,{origin:'https://foreign.example'}),c)).status).toBe(403)
  h.role.mockRejectedValueOnce(new ForbiddenError())
  expect((await acknowledgeScopedThread(req(token),c)).status).toBe(403)
  h.gate.mockReturnValue(false)
  expect((await acknowledgeScopedThread(req(token),c)).status).toBe(403)
  expect(h.rpc).not.toHaveBeenCalled()
 })
})
