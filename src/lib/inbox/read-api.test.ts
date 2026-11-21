import { describe,it,expect,vi,beforeEach } from 'vitest'
const h=vi.hoisted(()=>({role:vi.fn(),rpc:vi.fn(),isTest:vi.fn()}))
vi.mock('@/lib/auth/account',()=>({requireRole:h.role,UnauthorizedError:class extends Error{},ForbiddenError:class extends Error{}}))
vi.mock('@/lib/automations/admin-client',()=>({supabaseAdmin:()=>({rpc:h.rpc})}))
vi.mock('@/lib/whatsapp/transport/openwa/environment',()=>({isOpenWATestProject:h.isTest}))
import { inboxRead,parseInboxRead,encodeInboxCursor,decodeInboxCursor,safeInboxMedia } from './read-api'
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',c='33333333-3333-4333-8333-333333333333'
const req=(query='')=>new Request('https://example.test/api/inbox/threads'+query)
beforeEach(()=>{vi.clearAllMocks();h.role.mockResolvedValue({accountId:a,userId:b,role:'viewer'});h.isTest.mockReturnValue(true);vi.stubEnv('WACRM_INBOX_READ_API','test_only');vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','test-key');h.rpc.mockResolvedValue({data:{rows:[]},error:null})})
describe('inbox read API',()=>{
 it('rejects account override, duplicate filters, oversized limits and malformed scope',async()=>{
  for(const q of ['?account_id='+c,'?limit=101','?limit=0','?scope=invalid','?scope=unknown&channel_id='+c,'?limit=2&limit=3','?cursor=bogus'])
   expect((await inboxRead(req(q),'threads')).status).toBe(400)
  expect(h.rpc).not.toHaveBeenCalled()
 })
 it('binds signed cursor to actor, account, route, scope, channel and precise timestamp',()=>{
  const {input}=parseInboxRead(req('?channel_id='+c+'&limit=2'),'threads')
  const anchor={at:'2026-11-21T22:00:00.123456+00:00',id:c}
  const token=encodeInboxCursor(anchor,a,b,input,'key')
  expect(decodeInboxCursor(token,a,b,input,'key')).toEqual(anchor)
  for(const i of [{...input,scope:'historical' as const},{...input,channel:null},{...input,limit:3}])expect(()=>decodeInboxCursor(token,a,b,i,'key')).toThrow()
  expect(()=>decodeInboxCursor(token,c,b,input,'key')).toThrow()
  expect(()=>decodeInboxCursor(token,a,c,input,'key')).toThrow()
  expect(()=>decodeInboxCursor(token+'x',a,b,input,'key')).toThrow()
 })
 it('uses authenticated account and actor, bounds result, emits private no-store and next cursor',async()=>{
  h.rpc.mockResolvedValue({data:{rows:[{row_id:c,sort_at:null,payload:{id:c}},{row_id:b,sort_at:null,payload:{id:b}}]},error:null})
  const r=await inboxRead(req('?limit=1'),'threads');const body=await r.json()
  expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toContain('no-store')
  expect(body.items).toEqual([{id:c}]);expect(body.next_cursor).toBeTruthy()
  expect(h.rpc).toHaveBeenCalledWith('inbox_read_page',expect.objectContaining({p_account:a,p_actor:b,p_limit:1,p_scope:'active'}))
  await inboxRead(req('?limit=1&cursor='+body.next_cursor),'threads')
  expect(h.rpc).toHaveBeenLastCalledWith('inbox_read_page',expect.objectContaining({p_before_id:c,p_before_at:null}))
 })
 it('gates disabled flag and rejects cross-account/unknown IDs without revealing details',async()=>{
  h.isTest.mockReturnValue(false);expect((await inboxRead(req(),'threads')).status).toBe(403);expect(h.rpc).not.toHaveBeenCalled()
  h.isTest.mockReturnValue(true);h.rpc.mockResolvedValue({data:null,error:null})
  expect((await inboxRead(req(),'history',{thread:c})).status).toBe(404)
  h.rpc.mockResolvedValue({data:null,error:{code:'42501'}});expect((await inboxRead(req(),'threads')).status).toBe(403)
 })
 it('never returns arbitrary provider links, foreign storage paths or URL tokens',()=>{
  const base='https://test.supabase.co',url=base+'/storage/v1/object/public/chat-media/account-'+a+'/x.png'
  expect(safeInboxMedia(url,a,base)).toBe(url)
  for(const v of [url+'?token=secret',url.replace(a,c),url.replace(base,'https://evil.test'),url.replace('/x.png','/../x.png'),url.replace('/x.png','/%2fetc')])expect(safeInboxMedia(v,a,base)).toBeNull()
 })
})
