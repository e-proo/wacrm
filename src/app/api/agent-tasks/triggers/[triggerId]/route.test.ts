import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAgentCapability: vi.fn(),
  toErrorResponse: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  isOpenWATestProject: vi.fn(),
}))
vi.mock('@/lib/auth/account', () => ({
  requireAgentCapability: mocks.requireAgentCapability,
  toErrorResponse: mocks.toErrorResponse,
}))
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: mocks.rpc, from: mocks.from }),
}))
vi.mock('@/lib/whatsapp/transport/guardrails', () => ({
  isOpenWATestProject: mocks.isOpenWATestProject,
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response('', { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}))

import { PATCH } from './route'

const accountId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const agentId = '33333333-3333-4333-8333-333333333333'
const revisionId = '44444444-4444-4444-8444-444444444444'
const triggerId = '55555555-5555-4555-8555-555555555555'

function patch(data: unknown) {
  return PATCH(new Request('http://localhost/api/agent-tasks/triggers/' + triggerId, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  }), { params: Promise.resolve({ triggerId }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.WACRM_AGENT_TASK_SCHEDULING_ENABLE_TEST
  mocks.requireAgentCapability.mockResolvedValue({ accountId, userId })
  mocks.rpc.mockResolvedValue({ data: true, error: null })
  mocks.isOpenWATestProject.mockReturnValue(true)
  mocks.from.mockImplementation((table: string) => ({
    select() { return this }, eq() { return this },
    async maybeSingle() {
      if (table === 'ai_agent_task_triggers') return {
        data: { id: triggerId, status: 'paused',
          approved_revision_id: revisionId, agent_id: agentId }, error: null,
      }
      return { data: { id: agentId, status: 'active',
        published_revision_id: revisionId }, error: null }
    },
  }))
})

describe('SCH-2 tenant-scoped, no-surprise scheduler controls', () => {
  it('pauses using account-scoped existing RPC without touching WhatsApp', async () => {
    const result = await patch({ status: 'paused' })
    expect(result.status).toBe(200)
    expect(mocks.rpc).toHaveBeenCalledWith('set_agent_task_trigger_status', {
      p_account_id: accountId, p_trigger_id: triggerId, p_status: 'paused',
    })
  })

  it('refuses enabling without separate TEST gate even if actor is admin', async () => {
    const result = await patch({ status: 'enabled', confirmEnable: true })
    expect(result.status).toBe(409)
    expect((await result.json()).code).toBe('SCHEDULE_LIVE_ENABLE_NOT_AUTHORIZED')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('requires owner publish permission plus reviewed revision to enable', async () => {
    process.env.WACRM_AGENT_TASK_SCHEDULING_ENABLE_TEST = '1'
    mocks.requireAgentCapability.mockResolvedValue({ accountId, userId })
    const result = await patch({ status: 'enabled', confirmEnable: true })
    expect(result.status).toBe(200)
    expect(mocks.requireAgentCapability).toHaveBeenCalledWith('agents.publish')
    expect(mocks.rpc).toHaveBeenCalledWith('set_agent_task_trigger_status',
      expect.objectContaining({ p_account_id: accountId, p_status: 'enabled' }))
    delete process.env.WACRM_AGENT_TASK_SCHEDULING_ENABLE_TEST
  })

  it('rejects a foreign trigger before any privileged RPC', async () => {
    mocks.from.mockImplementation(() => ({
      select() { return this }, eq() { return this },
      async maybeSingle() { return { data: null, error: null } },
    }))
    const result = await patch({ status: 'paused' })
    expect(result.status).toBe(404)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
