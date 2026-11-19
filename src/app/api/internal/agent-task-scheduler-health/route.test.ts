import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => ({ guard: vi.fn(), from: vi.fn() }))
vi.mock('@/lib/whatsapp/transport/guardrails',()=>({isOpenWATestProject: stubs.guard}))
vi.mock('@/lib/ai/admin-client',()=>({supabaseAdmin:()=>({from:stubs.from})}))
import { GET } from './route'

const secret='w'.repeat(48)
const request=(token=secret)=>new Request('https://test.example/api/internal/agent-task-scheduler-health',{
  headers:{authorization:'Bearer '+token},
})
beforeEach(()=>{
  vi.clearAllMocks()
  vi.stubEnv('WACRM_MONITOR_SECRET', secret)
  stubs.guard.mockReturnValue(true)
  stubs.from.mockImplementation((name:string)=>{
    expect(name).toBe('ai_agent_task_scheduler_heartbeat')
    return {
      select(){return this},
      eq(key:string,value:string){
        expect([key,value]).toEqual(['runner','test_agent_task'])
        return this
      },
      maybeSingle(){return Promise.resolve({data:{
        last_succeeded_at:new Date(Date.now()-5000).toISOString(),
        last_started_at:new Date(Date.now()-5000).toISOString(),
        last_result:'success',consecutive_failures:0,tick_count:500,
      },error:null})},
    }
  })
})
afterEach(()=>vi.unstubAllEnvs())

describe('OW14-W04 external fail-closed monitor endpoint',()=>{
  it('requires pinned TEST and a separate monitoring secret before DB work',async()=>{
    stubs.guard.mockReturnValue(false)
    expect((await GET(request())).status).toBe(403)
    stubs.guard.mockReturnValue(true)
    vi.stubEnv('WACRM_MONITOR_SECRET','')
    expect((await GET(request())).status).toBe(503)
    expect(stubs.from).not.toHaveBeenCalled()
  })
  it('rejects wrong bearer secret without DB work',async()=>{
    expect((await GET(request('wrong'))).status).toBe(401)
    expect(stubs.from).not.toHaveBeenCalled()
  })
  it('returns sanitized healthy status from latest DB pulse',async()=>{
    const r=await GET(request())
    expect(r.status).toBe(200)
    const x=await r.json()
    expect(x.state).toBe('healthy')
    expect(Object.keys(x).sort()).toEqual(['age_seconds','reason','state','threshold_seconds'])
    expect(r.headers.get('cache-control')).toContain('no-store')
  })
  it('returns 503 so a configured outside monitor alerts on a stale tick',async()=>{
    stubs.from.mockImplementation(()=>({
      select(){return this},eq(){return this},
      maybeSingle(){return Promise.resolve({data:{
        last_succeeded_at:new Date(Date.now()-300000).toISOString(),last_result:'success',
        consecutive_failures:0,tick_count:400,
      },error:null})},
    }))
    const r=await GET(request())
    expect(r.status).toBe(503)
    expect((await r.json()).state).toBe('stopped')
  })
  it('fails closed on DB outages and never returns raw provider errors',async()=>{
    stubs.from.mockImplementation(()=>({
      select(){return this},eq(){return this},
      maybeSingle(){return Promise.resolve({data:null,error:new Error('secret or phone leak')})},
    }))
    const r=await GET(request())
    expect(r.status).toBe(503)
    expect(JSON.stringify(await r.json())).not.toMatch(/secret or phone leak/)
  })
})
