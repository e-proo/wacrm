import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isTest: vi.fn(), requireAgentCapability: vi.fn(), rpc: vi.fn(),
  taskStatuses: ['running','queued','paused'] as string[],
  runStatuses: ['queued','claimed'] as string[],
  enabled: true,
}))
vi.mock('@/lib/whatsapp/transport/guardrails', () => ({
  isOpenWATestProject: mocks.isTest,
}))
vi.mock('@/lib/auth/account', () => ({
  requireAgentCapability: mocks.requireAgentCapability,
  toErrorResponse: (error: Error) => {
    if (error.message === 'unauthorized') return new Response('Forbidden', { status: 403 })
    throw error
  },
}))
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: mocks.rpc,
    from(table: string) {
      const q = {
        select() { return q },
        eq() { return q },
        in() { return q },
        limit: async () => ({
          data: table === 'ai_agent_tasks'
            ? mocks.taskStatuses.map(status => ({ status }))
            : mocks.runStatuses.map(status => ({ status })),
          error: null,
        }),
        maybeSingle: async () => ({ data: { task_worker_enabled: mocks.enabled }, error: null }),
      }
      return q
    },
  }),
}))
import { GET, POST } from './route'
const accountId='11111111-1111-4111-8111-111111111111'
const userId='22222222-2222-4222-8222-222222222222'
const request = (action: string) => new Request('http://localhost/api/agent-tasks/worker', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action, accountId: 'foreign-tenant', userId: 'other-actor' }),
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.isTest.mockReturnValue(true)
  mocks.enabled=true
  mocks.requireAgentCapability.mockResolvedValue({ accountId, userId })
  mocks.rpc.mockResolvedValue({ data: { updated: true, enabled: false }, error: null })
})

describe('TEST per-account Agent Task worker controls', () => {
  it('fails closed on Production and unauthorized callers', async () => {
    mocks.isTest.mockReturnValue(false)
    expect((await GET()).status).toBe(403)
    expect((await POST(request('stop'))).status).toBe(403)
    expect(mocks.requireAgentCapability).not.toHaveBeenCalled()
    mocks.isTest.mockReturnValue(true)
    mocks.requireAgentCapability.mockRejectedValueOnce(new Error('unauthorized'))
    expect((await POST(request('start'))).status).toBe(403)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('checks tasks and outbound in read-only scoped, bounded form', async () => {
    const res=await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    expect(await res.json()).toMatchObject({
      enabled: true, tasks:{ running:1, queued:1, paused:1 },
      outbound:{ queued:1, inFlight:1 },
    })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('stops only server-derived account without trusting client IDs', async () => {
    mocks.enabled=false
    const res=await POST(request('stop'))
    expect(res.status).toBe(200)
    expect(mocks.requireAgentCapability).toHaveBeenCalledWith('agents.manage_tasks')
    expect(mocks.rpc).toHaveBeenCalledWith('set_agent_task_worker_enabled', {
      p_account_id: accountId,p_actor_user_id:userId,p_enabled:false,
    })
  })

  it('supports explicit start but rejects unrecognized actions and stale writes', async () => {
    expect((await POST(request('tick'))).status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect((await POST(request('start'))).status).toBe(200)
    expect(mocks.rpc).toHaveBeenCalledWith('set_agent_task_worker_enabled',
      expect.objectContaining({ p_enabled:true }))
    mocks.rpc.mockResolvedValueOnce({data:{updated:false,reason:'runtime_policy_missing'},error:null})
    expect((await POST(request('stop'))).status).toBe(409)
  })
})
