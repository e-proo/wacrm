import { beforeEach, describe, expect, it, vi } from 'vitest'

const stubs=vi.hoisted(()=>({
  guard:vi.fn(),auth:vi.fn(),probe:vi.fn(),rpc:vi.fn(),
  reads:[] as Array<{table:string,filters:Record<string,unknown>}>,
}))
vi.mock('@/lib/whatsapp/transport/guardrails',()=>({isOpenWATestProject:stubs.guard}))
vi.mock('@/lib/whatsapp/transport/openwa/session-auth',()=>({requireOpenWASessionAdmin:stubs.auth}))
vi.mock('@/lib/whatsapp/transport/openwa/native-ack-provider',()=>({
  inspectOpenWANativeAck:stubs.probe,
}))
import {POST} from './route'

const connectionId='11111111-2222-4333-8444-555555555555'
const jobId='99999999-2222-4333-8444-555555555555'
const accountId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const userId='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ctx={params:Promise.resolve({connectionId,jobId})}
const req=(action:string,confirmed=true)=>new Request('https://test.example/api/disposition',{
  method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({action,confirm_no_resend:confirmed}),
})

function db(options:{missing?:boolean;dbError?:boolean}={}){
  const from=vi.fn((table:string)=>{
    const filters:Record<string,unknown>={}
    const query={
      select:()=>query,
      eq:(k:string,v:unknown)=>{filters[k]=v;return query},
      is:(k:string,v:unknown)=>{filters[k]=v;return query},
      in:(k:string,v:unknown)=>{filters[k]=v;return query},
      maybeSingle:async()=>{
        stubs.reads.push({table,filters:{...filters}})
        if(options.dbError)return {data:null,error:{message:'PRIVATE_PII'}}
        if(options.missing)return {data:null,error:null}
        return {data:table==='whatsapp_connections'
          ?{session_id:'test-session',phone_identity:'967700000001',instance_id:'instance',status:'ready'}
          :{session_id:'test-session',own_phone_identity:'967700000001',
            instance_id:'instance',provider_message_id:'native_PRIVATE',
            event_kind:'unmatched_status'},error:null}
      },
    }
    return query
  })
  return {from,rpc:stubs.rpc}
}

beforeEach(()=>{
  vi.clearAllMocks()
  stubs.reads=[]
  stubs.guard.mockReturnValue(true)
  stubs.rpc.mockResolvedValue({data:{updated:true,disposition:'closed_unverified'},error:null})
  stubs.probe.mockResolvedValue({code:'archive_outbound_found',archive_status:'read',
    whatsapp_delivery_confirmed:false,outbound_resent:false})
  stubs.auth.mockResolvedValue({accountId,user:{id:userId},adminDb:db()})
})

describe('OW14-W05 audited terminal ACK disposition',()=>{
  it('records an explicitly confirmed unverified closure without querying gateway',async()=>{
    const response=await POST(req('close_unverified'),ctx)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      updated:true,disposition:'closed_unverified',
      delivery_confirmed:false,outbound_resent:false,
    })
    expect(stubs.probe).not.toHaveBeenCalled()
    expect(stubs.rpc).toHaveBeenCalledWith('close_openwa_unmatched_ack',{
      p_account_id:accountId,p_connection_id:connectionId,p_job_id:jobId,
      p_actor:userId,p_finding:'no_verified_evidence',
      p_gateway_status:null,p_confirm_no_resend:true,
    })
  })
  it('requires independent actual provider verification before archive disposition',async()=>{
    stubs.rpc.mockResolvedValue({data:{
      updated:true,disposition:'closed_archive_observed'},error:null})
    const response=await POST(req('close_archive_observed'),ctx)
    expect(response.status).toBe(200)
    expect(stubs.probe).toHaveBeenCalledWith(expect.anything(),accountId,connectionId,
      expect.objectContaining({session_id:'test-session'}),
      expect.objectContaining({provider_message_id:'native_PRIVATE'}))
    expect(stubs.rpc).toHaveBeenCalledWith('close_openwa_unmatched_ack',
      expect.objectContaining({p_finding:'gateway_archive_observed',p_gateway_status:'read'}))
  })
  it('refuses absent/failed/foreign-session provider archive evidence',async()=>{
    for(const code of ['not_in_gateway_archive','gateway_unavailable','session_identity_unverified']){
      stubs.probe.mockResolvedValueOnce({code,archive_status:null})
      const result=await POST(req('close_archive_observed'),ctx)
      expect(result.status).toBe(409)
    }
    expect(stubs.rpc).not.toHaveBeenCalled()
  })
  it('rejects non-TEST, non-admin, invalid path or missing no-resend approval before DB',async()=>{
    stubs.guard.mockReturnValueOnce(false)
    expect((await POST(req('close_unverified'),ctx)).status).toBe(403)
    expect(stubs.auth).not.toHaveBeenCalled()
    stubs.auth.mockRejectedValueOnce(new Error('FORBIDDEN'))
    expect((await POST(req('close_unverified'),ctx)).status).toBe(403)
    expect((await POST(req('close_unverified',false),ctx)).status).toBe(400)
    expect((await POST(req('wrong'),ctx)).status).toBe(400)
    expect((await POST(req('close_unverified'),{
      params:Promise.resolve({connectionId:'bad',jobId}),
    })).status).toBe(400)
    expect(stubs.rpc).not.toHaveBeenCalled()
  })
  it('does not update on DB stale-state, local match or actor failure',async()=>{
    stubs.rpc.mockResolvedValueOnce({data:{updated:false,reason:'local_match_requires_reconciliation'},error:null})
    const response=await POST(req('close_unverified'),ctx)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({updated:false,reason:'local_match_requires_reconciliation'})
    expect(stubs.rpc).toHaveBeenCalledTimes(1)
  })
  it('fails closed and redacts DB/provider exceptions',async()=>{
    stubs.rpc.mockResolvedValueOnce({data:null,error:{message:'secret_PII_native_ID'}})
    const result=await POST(req('close_unverified'),ctx)
    expect(result.status).toBe(503)
    expect(JSON.stringify(await result.json())).not.toMatch(/secret_PII|native_ID/)
    stubs.auth.mockResolvedValueOnce({accountId,user:{id:userId},adminDb:db({dbError:true})})
    const error=await POST(req('close_archive_observed'),ctx)
    expect(error.status).toBe(503)
    expect(stubs.probe).not.toHaveBeenCalled()
  })
})
