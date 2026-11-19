import { beforeEach, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => ({
  guard: vi.fn(), auth: vi.fn(), error: vi.fn((err: unknown) => { throw err }),
  from: vi.fn(), rpc: vi.fn(),
}))
vi.mock('@/lib/auth/account', () => ({
  requireAgentCapability: stubs.auth, toErrorResponse: stubs.error,
}))
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({ from: stubs.from, rpc: stubs.rpc }),
}))
vi.mock('@/lib/whatsapp/transport/guardrails', () => ({
  isOpenWATestProject: stubs.guard,
}))
import { GET, POST } from './route'

const accountId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  vi.clearAllMocks()
  stubs.guard.mockReturnValue(true)
  stubs.auth.mockResolvedValue({accountId,userId})
  stubs.rpc.mockImplementation((name: string, args: Record<string, unknown>) => {
    if (name === 'inspect_agent_task_schedule_health') {
      expect(args).toEqual({p_account_id:accountId})
      return Promise.resolve({ data: {
        runnerLastSucceededAt: new Date(Date.now()-4000).toISOString(),
        runnerLastStartedAt: new Date(Date.now()-4000).toISOString(),
        runnerTickCount:123,runnerConsecutiveFailures:0,runnerLastResult:'success',
      }, error:null})
    }
    if (name === 'set_agent_task_worker_enabled') {
      expect(args).toMatchObject({p_account_id: accountId,p_actor_user_id:userId})
      return Promise.resolve({data:{updated:true},error:null})
    }
    throw Error('Unexpected RPC '+name)
  })
  stubs.from.mockImplementation((name: string) => ({
    select() { return this },
    eq(key: string,value: string) {
      if (key === 'account_id') expect(value).toBe(accountId)
      else if (key === 'run_mode') expect(value).toBe('outbound')
      else throw new Error('Unexpected query scope')
      return this
    },
    maybeSingle() { return Promise.resolve({data:{task_worker_enabled:true},error:null}) },
    in() { return this },
    limit() {
      if (name === 'ai_agent_runs') return Promise.resolve({data:[{status:'queued'}],error:null})
      return Promise.resolve({data:[{status:'completed'},{status:'queued'}],error:null})
    },
  }))
})

describe('OW14-W04 tenant-safe worker status', () => {
  it('reports durable TEST DB pulse without checking NODE_ENV or npm runner', async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    const body = await response.json()
    expect(body).toMatchObject({
      enabled:true,
      scheduler:{state:'healthy',tickCount:123,source:'shared_test_database_heartbeat'},
      tasks:{queued:1},
      outbound:{queued:1},
    })
    expect(body).not.toHaveProperty('localRunnerAvailable')
    expect(stubs.auth).toHaveBeenCalledWith('agents.manage_tasks')
    expect(stubs.from).not.toHaveBeenCalledWith('ai_agent_task_scheduler_heartbeat')
  })
  it('rejects non-TEST without authorization or database access', async () => {
    stubs.guard.mockReturnValue(false)
    expect((await GET()).status).toBe(403)
    expect(stubs.auth).not.toHaveBeenCalled()
    expect(stubs.from).not.toHaveBeenCalled()
    expect(stubs.rpc).not.toHaveBeenCalled()
  })
  it('requires agent task management capability before any database query', async () => {
    stubs.auth.mockRejectedValue(new Error('FORBIDDEN'))
    await expect(GET()).rejects.toThrow('FORBIDDEN')
    expect(stubs.rpc).not.toHaveBeenCalled()
    expect(stubs.from).not.toHaveBeenCalled()
  })
  it('shows stalled heartbeat as an alert without dispatching tasks', async () => {
    stubs.rpc.mockResolvedValue({data:{
      runnerLastSucceededAt:new Date(Date.now()-300000).toISOString(),
      runnerTickCount:23,runnerConsecutiveFailures:0,
    },error:null})
    const body = await (await GET()).json()
    expect(body.scheduler.state).toBe('stopped')
    expect(stubs.rpc).not.toHaveBeenCalledWith('begin_agent_task_scheduler_tick',expect.anything())
  })
  it('preserves account-scoped STOP with the existing RPC', async () => {
    const response = await POST(new Request('http://localhost/api/agent-tasks/worker',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({action:'stop',accountId:'FOREIGN'}),
    }))
    expect(response.status).toBe(200)
    expect(stubs.rpc).toHaveBeenCalledWith('set_agent_task_worker_enabled',{
      p_account_id:accountId,p_actor_user_id:userId,p_enabled:false,
    })
  })
})
