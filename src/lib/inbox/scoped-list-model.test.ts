import { describe,it,expect,vi,afterEach } from 'vitest'
import { defaultFilters,fetchInbox,listQuery,parseLocation,preferenceKey,readPreference,sameScope,selectExact,selectionHref,mergePage,pagePath,type ScopedRow,type InboxContext } from './scoped-list-model'
import { scopedInboxEnabled } from './scoped-ui-gate'
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',c='33333333-3333-4333-8333-333333333333',d='44444444-4444-4444-8444-444444444444'
const ctx:InboxContext={accountId:a,userId:b}
const row=(id:string,channel:string|null,scope:ScopedRow['scope']='active'):ScopedRow=>({id,conversation_id:d,channel_id:channel,provider:channel?'openwa':null,scope,read_only:true,route_ready:scope==='active',status:'open',preview:'fixture',last_message_at:null,unread_count_known:1,contact:{id:a,name:'Fixture',phone:'15551234567',company:null}})
afterEach(()=>vi.unstubAllGlobals())
describe('scoped inbox selection and fetch boundary',()=>{
 it('defaults to all active and validates exact and legacy links',()=>{
  expect(parseLocation('')).toMatchObject({scope:'active',channel:null,thread:null,invalid:false})
  expect(parseLocation('c='+d+'&connection='+a)).toMatchObject({legacy:true,parent:d,connection:a})
  expect(parseLocation('c='+d+'&thread='+b+'&connection='+a)).toMatchObject({legacy:true,thread:b})
  expect(parseLocation('scope=unknown&c='+d)).toMatchObject({legacy:false,scope:'unknown'})
  for(const q of ['scope=unknown&channel='+a,'thread=forged','scope=active&scope=historical','thread='+b+'&connection='+a])expect(parseLocation(q).invalid).toBe(true)
 })
 it('retains all-channel filter when selecting and checks channel/parent/thread',()=>{
  const first=row(b,a),second=row(c,d),url=selectionHref('active',null,first)
  expect(url).not.toContain('channel=')
  expect(selectExact([first,second],parseLocation(url.split('?')[1]))).toBe(first)
  expect(selectExact([first,second],parseLocation('scope=active&channel='+d+'&thread='+b))).toBeNull()
  expect(selectExact([first],parseLocation('scope=active&thread='+b+'&c='+a))).toBeNull()
  expect(sameScope(row(c,a,'historical'),'active',a)).toBe(false)
  expect(sameScope(row(d,null,'unknown'),'active',null)).toBe(false)
 })
 it('deduplicates overlapping pages by thread, not contact',()=>{
  const first=row(b,a),second=row(c,d)
  expect(mergePage([first],[first,second])).toEqual([first,second])
  expect(pagePath('threads?scope=active','a+b')).toBe('threads?scope=active&cursor=a%2Bb')
 })
 it('binds all filters and scopes preferences by account and actor',()=>{
  const q=new URLSearchParams(listQuery('active',a,{...defaultFilters,search:' preview ',unread:true,assignment:'mine',tags:[c,b],company:' ACME '}))
  expect(q.get('channel_id')).toBe(a);expect(q.get('search')).toBe('preview');expect(q.get('tags')).toBe(b+','+c);expect(q.get('unread')).toBe('true')
  expect(preferenceKey(ctx)).not.toBe(preferenceKey({accountId:c,userId:b}))
  expect(preferenceKey(ctx)).not.toBe(preferenceKey({accountId:a,userId:c}))
  expect(readPreference(JSON.stringify({scope:'historical',channel:a,search:'ignored'}))).toEqual({scope:'historical',channel:a})
  expect(readPreference(JSON.stringify({scope:'unknown',channel:a}))).toBeNull()
 })
 it('rejects late results even if fetch ignores aborted request',async()=>{
  let resolve!:(r:Response)=>void
  const mock=vi.fn(()=>new Promise<Response>(r=>resolve=r));vi.stubGlobal('fetch',mock)
  const controller=new AbortController(),pending=fetchInbox('threads?scope=active',ctx,controller.signal)
  controller.abort();resolve(Response.json({read_only:true,items:[row(c,a)]}))
  await expect(pending).rejects.toThrow()
  expect(mock).toHaveBeenCalledWith('/api/inbox/threads?scope=active',expect.objectContaining({method:'GET',cache:'no-store',headers:{'x-wacrm-inbox-account':a,'x-wacrm-inbox-actor':b}}))
 })
 it('fails closed if either flag is absent or project differs',()=>{
  const env: NodeJS.ProcessEnv={NODE_ENV:'test',NEXT_PUBLIC_SUPABASE_URL:'https://pqirsnfupofhulmewakq.supabase.co',WACRM_INBOX_READ_API:'test_only',WACRM_INBOX_SCOPED_UI:'test_only'}
  expect(scopedInboxEnabled(env)).toBe(true)
  expect(scopedInboxEnabled({...env,WACRM_INBOX_SCOPED_UI:'off'})).toBe(false)
  expect(scopedInboxEnabled({...env,WACRM_INBOX_READ_API:'off'})).toBe(false)
  expect(scopedInboxEnabled({...env,NEXT_PUBLIC_SUPABASE_URL:'https://prod.example'})).toBe(false)
 })
})
