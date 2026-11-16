import { beforeEach, describe, expect, it, vi } from 'vitest'

const m=vi.hoisted(() => ({
  cap:vi.fn(), pause:vi.fn(), resume:vi.fn(), rpc:vi.fn(),
}))
vi.mock('@/lib/auth/account', () => ({
  requireAgentCapability:m.cap,
  toErrorResponse:(error: Error) => {
    if (error.message==='unauthorized') return new Response('Forbidden',{status:403})
    throw error
  },
}))
vi.mock('@/lib/ai/tasks/orchestrator', () => ({
  pauseAgentTask:m.pause, resumeAgentTask:m.resume,
}))
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin:()=>({rpc:m.rpc}),
}))
import { POST } from './route'

const accountId='11111111-1111-4111-8111-111111111111'
const userId='22222222-2222-4222-8222-222222222222'
const taskId='33333333-3333-4333-8333-333333333333'
const context=()=>({params:Promise.resolve({taskId})})
const req=(action:string,note:string|null=null)=>
  new Request('http://localhost/api/agent-tasks/'+taskId+'/control',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({action,note,accountId:'wrong-tenant',userId:'wrong-user'}),
  })
beforeEach(()=>{
  vi.clearAllMocks()
  m.cap.mockResolvedValue({accountId,userId})
  m.pause.mockResolvedValue(true)
  m.resume.mockResolvedValue(true)
  m.rpc.mockResolvedValue({data:{updated:true,status:'partially_completed'},error:null})
})

describe('Admin Task cancellation and explicit manual outcome',()=>{
  it('rejects unauthorized operator, invalid IDs and arbitrary actions',async()=>{
    m.cap.mockRejectedValueOnce(new Error('unauthorized'))
    expect((await POST(req('cancel'),context())).status).toBe(403)
    expect((await POST(req('cancel'),{params:Promise.resolve({taskId:'foreign-id'})})).status).toBe(400)
    expect((await POST(req('destroy'),context())).status).toBe(400)
    expect(m.rpc).not.toHaveBeenCalled()
  })
  it('uses existing tenant-scoped SQL pause and resume, not a client tenant',async()=>{
    expect((await POST(req('pause'),context())).status).toBe(200)
    expect((await POST(req('resume'),context())).status).toBe(200)
    expect(m.pause).toHaveBeenCalledWith({accountId,taskId,actorId:userId})
    expect(m.resume).toHaveBeenCalledWith({accountId,taskId,actorId:userId})
    m.pause.mockResolvedValueOnce(false)
    expect((await POST(req('pause'),context())).status).toBe(409)
  })
  it('routes cancel or finish through atomic SQL with authenticated actor',async()=>{
    const response=await POST(req('finish_incomplete','تجربة مبكرة'),context())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({updated:true,status:'partially_completed'})
    expect(m.rpc).toHaveBeenCalledWith('admin_close_agent_task',{
      p_account_id:accountId,p_task_id:taskId,p_actor_user_id:userId,
      p_mode:'finish_incomplete',p_note:'تجربة مبكرة',
    })
    expect((await POST(req('cancel'),context())).status).toBe(200)
    expect(m.rpc).toHaveBeenCalledWith('admin_close_agent_task',
      expect.objectContaining({p_mode:'cancel',p_account_id:accountId}))
  })
  it('rejects any in-flight / ambiguous send without manufacturing completion',async()=>{
    m.rpc.mockResolvedValueOnce({data:{updated:false,reason:'in_flight_or_reconciliation'},error:null})
    const res=await POST(req('finish_complete'),context())
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({code:'in_flight_or_reconciliation'})
    m.rpc.mockResolvedValueOnce({data:{updated:false,reason:'targets_not_completed'},error:null})
    expect((await POST(req('finish_complete'),context())).status).toBe(409)
  })
  it('does not accept oversized closure notes',async()=>{
    expect((await POST(req('cancel','x'.repeat(501)),context())).status).toBe(400)
    expect(m.rpc).not.toHaveBeenCalled()
  })
})
