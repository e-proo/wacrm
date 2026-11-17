import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => ({
  isTest: vi.fn(), triggers: vi.fn(), tasks: vi.fn(), outbound: vi.fn(),
  rpc: vi.fn(),
}))
vi.mock('@/lib/whatsapp/transport/guardrails', () => ({
  isOpenWATestProject: stubs.isTest,
}))
vi.mock('@/lib/ai/tasks/trigger-worker', () => ({
  processAgentTaskTriggerQueue: stubs.triggers,
}))
vi.mock('@/lib/ai/tasks/orchestrator', () => ({
  processAgentTaskQueue: stubs.tasks,
}))
vi.mock('@/lib/ai/tasks/outbound-worker', () => ({
  processAgentTaskOutboundRunQueue: stubs.outbound,
}))

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: stubs.rpc }),
}))
import { POST } from './route'

function request(secret = 'test-secret') {
  return new Request('http://localhost/api/internal/ai-agent-task-worker', {
    method: 'POST',headers:{authorization:'Bearer '+secret},
  })
}

beforeEach(() => {
  vi.stubEnv('CRON_SECRET','test-secret')
  vi.clearAllMocks()
  stubs.isTest.mockReturnValue(true)
  stubs.rpc.mockImplementation(async (name: string) => ({
    data: name === 'begin_agent_task_scheduler_tick' ||
          name === 'finish_agent_task_scheduler_tick', error: null,
  }))
  stubs.triggers.mockResolvedValue({completed:0})
  stubs.tasks.mockResolvedValue({claimedTasks:1,createdRuns:1})
  stubs.outbound.mockResolvedValue({attempted:1,sent:0})
})
afterEach(() => vi.unstubAllEnvs())

describe('TEST-only automatic Agent Task worker endpoint', () => {
  it('rejects production before accessing any queue or credential', async () => {
    stubs.isTest.mockReturnValue(false)
    expect((await POST(request())).status).toBe(403)
    expect(stubs.tasks).not.toHaveBeenCalled()
  })
  it('fails closed without a configured secret or on invalid authorization', async () => {
    vi.stubEnv('CRON_SECRET','')
    expect((await POST(request())).status).toBe(503)
    vi.stubEnv('CRON_SECRET','test-secret')
    expect((await POST(request('wrong'))).status).toBe(401)
    expect(stubs.tasks).not.toHaveBeenCalled()
  })
  it('uses bounded ordered trigger -> task -> outbound stages, with no unrelated worker', async () => {
    const res = await POST(request())
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    expect(await res.json()).toMatchObject({
      triggers:{completed:0},tasks:{claimedTasks:1},outbound:{attempted:1},
    })
    expect(stubs.triggers).toHaveBeenCalledWith(
      expect.objectContaining({limit:2}))
    expect(stubs.tasks).toHaveBeenCalledWith(
      expect.objectContaining({limit:2}))
    expect(stubs.outbound).toHaveBeenCalledWith(
      expect.objectContaining({limit:2}))
    expect(stubs.triggers.mock.invocationCallOrder[0])
      .toBeLessThan(stubs.tasks.mock.invocationCallOrder[0])
    expect(stubs.tasks.mock.invocationCallOrder[0])
      .toBeLessThan(stubs.outbound.mock.invocationCallOrder[0])
  })
  it('reports generic failures without disclosing server credentials', async () => {
    stubs.tasks.mockRejectedValueOnce(new Error('private-service-role-secret'))
    const spy=vi.spyOn(console,'error').mockImplementation(()=>{})
    const response=await POST(request())
    spy.mockRestore()
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain('private-service-role-secret')
    expect(stubs.outbound).not.toHaveBeenCalled()
  })
})

describe('SCH-4 durable TEST tick recovery', () => {
  it('returns busy 202 with Retry-After without touching any queue', async () => {
    stubs.rpc.mockResolvedValueOnce({data:false,error:null})
    const result=await POST(request())
    expect(result.status).toBe(202)
    expect(result.headers.get('Retry-After')).toBe('30')
    expect(await result.json()).toMatchObject({busy:true})
    expect(stubs.triggers).not.toHaveBeenCalled()
    expect(stubs.tasks).not.toHaveBeenCalled()
    expect(stubs.outbound).not.toHaveBeenCalled()
  })
  it('releases the matching durable owner and logs only bounded counts', async () => {
    stubs.triggers.mockResolvedValueOnce({
      claimed:2,completed:1,failed:1,dead:0,
    })
    const result=await POST(request())
    expect(result.status).toBe(200)
    const begin=stubs.rpc.mock.calls.find(([name])=>
      name==='begin_agent_task_scheduler_tick')
    const finish=stubs.rpc.mock.calls.find(([name])=>
      name==='finish_agent_task_scheduler_tick')
    expect(begin?.[1]).toMatchObject({p_lease_seconds:120})
    expect(finish?.[1]).toMatchObject({
      p_owner:begin?.[1].p_owner,p_success:true,
      p_claimed:2,p_completed:1,p_failed:1,p_dead:0,
    })
  })
  it('marks a failed tick recoverable and prevents later outbound processing', async () => {
    stubs.tasks.mockRejectedValueOnce(new Error('private-api-token-data'))
    const spy=vi.spyOn(console,'error').mockImplementation(()=>{})
    const response=await POST(request())
    spy.mockRestore()
    expect(response.status).toBe(500)
    expect(stubs.outbound).not.toHaveBeenCalled()
    expect(stubs.rpc).toHaveBeenCalledWith('finish_agent_task_scheduler_tick',
      expect.objectContaining({p_success:false}))
    expect(JSON.stringify(await response.json())).not.toContain('private-api-token-data')
  })
  it('fails closed if the database cannot enforce the lease', async () => {
    stubs.rpc.mockRejectedValueOnce(new Error('secret-db-error'))
    const spy=vi.spyOn(console,'error').mockImplementation(()=>{})
    const result=await POST(request())
    spy.mockRestore()
    expect(result.status).toBe(500)
    expect(stubs.triggers).not.toHaveBeenCalled()
    expect(stubs.tasks).not.toHaveBeenCalled()
  })
  it('does not report false success if its finishing lease has been reclaimed', async () => {
    stubs.rpc.mockImplementation(async(name: string)=>({
      data:name==='begin_agent_task_scheduler_tick',error:null,
    }))
    const spy=vi.spyOn(console,'error').mockImplementation(()=>{})
    const result=await POST(request())
    spy.mockRestore()
    expect(result.status).toBe(500)
    expect(stubs.outbound).toHaveBeenCalledTimes(1)
  })
})
