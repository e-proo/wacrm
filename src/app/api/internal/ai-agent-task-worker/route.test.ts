import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => ({
  isTest: vi.fn(), triggers: vi.fn(), tasks: vi.fn(), outbound: vi.fn(),
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
