import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  guard: vi.fn(), auth: vi.fn(), resolve: vi.fn(),
  session: vi.fn(), request: vi.fn(), queries: [] as Array<{table:string,filters:Record<string,unknown>}>,
}))
vi.mock('@/lib/whatsapp/transport/guardrails', () => ({
  isOpenWATestProject: mock.guard,
}))
vi.mock('@/lib/whatsapp/transport/openwa/session-auth', () => ({
  requireOpenWASessionAdmin: mock.auth,
}))
vi.mock('@/lib/whatsapp/transport/openwa/credentials', () => ({
  resolveOpenWAClient: mock.resolve,
}))

import { GET } from './route'

const conn = '11111111-2222-4333-8444-555555555555'
const job = '99999999-2222-4333-8444-555555555555'
const account = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const native = 'true_123@c.us_NATIVE'
const sid = 'linked-session'
const phone = '967700000001'
const context = { params: Promise.resolve({connectionId:conn, jobId:job}) }

function db(options: { rebound?: boolean; missingJob?: boolean; readError?: boolean } = {}) {
  const from = vi.fn((table:string) => {
    const filters: Record<string,unknown> = {}
    const q = {
      select:() => q,
      eq:(name:string,value:unknown) => {filters[name]=value; return q},
      in:(name:string,value:unknown) => {filters[name]=value; return q},
      is:(name:string,value:unknown) => {filters[name]=value; return q},
      maybeSingle:async () => {
        mock.queries.push({table,filters:{...filters}})
        if(options.readError)return {data:null,error:{message:'PROVIDER_SECRET_PRIVATE'}}
        if(table==='whatsapp_connections') return {data:{
          id:conn,session_id:options.rebound?'new-session':sid,
          phone_identity:phone,instance_id:'instance',
          status:'ready',
        },error:null}
        if(options.missingJob)return {data:null,error:null}
        return {data:{id:job,session_id:sid,own_phone_identity:phone,
          instance_id:'instance',provider_message_id:native,
          event_kind:'unmatched_status',state:'pending'},error:null}
      },
    }
    return q
  })
  return {from}
}

beforeEach(()=>{
  vi.clearAllMocks()
  mock.queries=[]
  mock.guard.mockReturnValue(true)
  mock.auth.mockResolvedValue({accountId:account,adminDb:db()})
  mock.session.mockResolvedValue({sessionId:sid,status:'ready',phoneIdentity:phone})
  mock.request.mockResolvedValue({total:1,messages:[{
    waMessageId:native,sessionId:sid,direction:'outgoing',status:'read',
    body:'PRIVATE_CONTENT',from:'PRIVATE_PHONE',metadata:{secret:'PRIVATE_KEY'},
  }]})
  mock.resolve.mockResolvedValue({client:{getSessionStatus:mock.session,request:mock.request}})
})
afterEach(()=>vi.unstubAllEnvs())

describe('OW14-W05 read-only native ACK evidence endpoint',()=>{
  it('uses same-account session + exact native GET and redacts all private content',async()=>{
    const r=await GET(new Request('https://localhost/'),context)
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toContain('no-store')
    const body=await r.json()
    expect(body).toEqual({code:'archive_outbound_found',archive_status:'read',
      whatsapp_delivery_confirmed:false,outbound_resent:false})
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE|NATIVE|9677|session/)
    expect(mock.resolve).toHaveBeenCalledWith(expect.anything(),account,conn,{timeoutMs:7000})
    expect(mock.session).toHaveBeenCalledWith(sid)
    expect(mock.request).toHaveBeenCalledWith(
      '/api/sessions/linked-session/messages?messageId='+encodeURIComponent(native)+
        '&direction=outgoing&limit=2&inlineMedia=false',
      {timeoutMs:7000},
    )
    expect(mock.queries).toEqual(expect.arrayContaining([
      {table:'whatsapp_connections',filters:{
        account_id:account,id:conn,provider:'openwa',archived_at:null,
      }},
      {table:'openwa_deferred_events',filters:{
        account_id:account,connection_id:conn,id:job,event_kind:'unmatched_status',
        state:['pending','review'],
      }},
    ]))
    expect(mock.auth).toHaveBeenCalledOnce()
  })
  it('rejects non TEST before touching auth or DB',async()=>{
    mock.guard.mockReturnValue(false)
    expect((await GET(new Request('https://localhost/'),context)).status).toBe(403)
    expect(mock.auth).not.toHaveBeenCalled()
    expect(mock.resolve).not.toHaveBeenCalled()
  })
  it('blocks non-admin and malformed connection/job identifiers',async()=>{
    mock.auth.mockRejectedValueOnce(new Error('FORBIDDEN'))
    expect((await GET(new Request('https://localhost/'),context)).status).toBe(403)
    expect(mock.resolve).not.toHaveBeenCalled()
    expect((await GET(new Request('https://localhost/'),{
      params:Promise.resolve({connectionId:'not-uuid',jobId:job}),
    })).status).toBe(400)
  })
  it('blocks missing job and mismatched/rebound session before gateway call',async()=>{
    mock.auth.mockResolvedValueOnce({accountId:account,adminDb:db({missingJob:true})})
    expect((await GET(new Request('https://localhost/'),context)).status).toBe(404)
    expect(mock.resolve).not.toHaveBeenCalled()
    mock.auth.mockResolvedValueOnce({accountId:account,adminDb:db({rebound:true})})
    const r=await GET(new Request('https://localhost/'),context)
    expect(r.status).toBe(409)
    expect((await r.json()).code).toBe('session_identity_unverified')
    expect(mock.resolve).not.toHaveBeenCalled()
  })
  it('blocks gateway own-phone mismatch before querying archive',async()=>{
    mock.session.mockResolvedValueOnce({sessionId:sid,status:'ready',phoneIdentity:'967700000002'})
    const r=await GET(new Request('https://localhost/'),context)
    expect(r.status).toBe(409)
    expect((await r.json()).code).toBe('session_identity_unverified')
    expect(mock.request).not.toHaveBeenCalled()
  })
  it('reports absence without marking a send failed or retrying',async()=>{
    mock.request.mockResolvedValueOnce({total:0,messages:[]})
    expect(await (await GET(new Request('https://localhost/'),context)).json())
      .toMatchObject({code:'not_in_gateway_archive',archive_status:null,
        whatsapp_delivery_confirmed:false,outbound_resent:false})
    expect(mock.request).toHaveBeenCalledTimes(1)
  })
  it('returns 503 redacted on upstream failure without provider side effects',async()=>{
    mock.request.mockRejectedValueOnce(new Error('secret=PRIVATE_GATEWAY_KEY chat=PERSONAL'))
    const r=await GET(new Request('https://localhost/'),context)
    expect(r.status).toBe(503)
    const s=JSON.stringify(await r.json())
    expect(s).not.toMatch(/PRIVATE|PERSONAL|secret|chat=/)
    expect(mock.request).toHaveBeenCalledTimes(1)
  })
  it('fails closed on a DB error before OpenWA',async()=>{
    mock.auth.mockResolvedValueOnce({accountId:account,adminDb:db({readError:true})})
    const r=await GET(new Request('https://localhost/'),context)
    expect(r.status).toBe(503)
    expect(mock.resolve).not.toHaveBeenCalled()
    expect(JSON.stringify(await r.json())).not.toContain('PROVIDER_SECRET_PRIVATE')
  })
})
