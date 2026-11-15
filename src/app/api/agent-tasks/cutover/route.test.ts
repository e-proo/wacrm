import { beforeEach, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => ({
  requireRole: vi.fn(),
  assertAgentCapability: vi.fn(),
  toErrorResponse: vi.fn((error: unknown) => { throw error }),
  rateLimit: vi.fn(),
  inspect: vi.fn(),
  change: vi.fn(),
  testProject: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: stubs.requireRole,
  assertAgentCapability: stubs.assertAgentCapability,
  toErrorResponse: stubs.toErrorResponse,
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: stubs.rateLimit,
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: { max: 30, windowMs: 60_000 } },
}))
vi.mock('@/lib/ai/tasks/cutover', () => ({
  inspectAgentTaskTestCutoverReadiness: stubs.inspect,
  setAgentTaskTestCutoverMode: stubs.change,
}))
vi.mock('@/lib/whatsapp/transport/guardrails', () => ({
  isOpenWATestProject: stubs.testProject,
}))

import { GET, POST } from './route'

const accountId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'

function request(data: unknown) {
  return new Request('http://localhost/api/agent-tasks/cutover', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  })
}
function readiness(mode: 'disabled' | 'pilot' | 'inconsistent' = 'disabled', ready = true) {
  return { accountId, mode, ready, blockers: ready ? [] : ['OUTBOUND_RECONCILIATION_REQUIRED'] }
}

beforeEach(() => {
  vi.clearAllMocks()
  stubs.requireRole.mockResolvedValue({ accountId, userId, role: 'admin' })
  stubs.testProject.mockReturnValue(true)
  stubs.rateLimit.mockReturnValue({ success: true })
  stubs.inspect.mockResolvedValue(readiness())
  stubs.change.mockResolvedValue({ mode: 'pilot', changed: true, before: readiness(), after: readiness('pilot') })
})

describe('TEST Agent Task cutover UI API', () => {
  it('reads actual account-scoped atomic readiness without changing the gate', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    expect((await res.json()).readiness.mode).toBe('disabled')
    expect(stubs.requireRole).toHaveBeenCalledWith('admin')
    expect(stubs.assertAgentCapability).toHaveBeenCalledWith(
      expect.objectContaining({ accountId }), 'agents.manage_tasks',
    )
    expect(stubs.inspect).toHaveBeenCalledWith({ accountId })
    expect(stubs.change).not.toHaveBeenCalled()
  })

  it('rejects every activation outside the pinned TEST project', async () => {
    stubs.testProject.mockReturnValue(false)
    const res = await POST(request({ mode: 'pilot', confirmation: 'ENABLE_TEST_AGENT_TASK_PILOT' }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('TEST_ONLY')
    expect(stubs.inspect).not.toHaveBeenCalled()
    expect(stubs.change).not.toHaveBeenCalled()
  })

  it('requires account admin + fine-grained capability before invoking privileged RPCs', async () => {
    stubs.requireRole.mockRejectedValue(new Error('forbidden'))
    await expect(GET()).rejects.toThrow('forbidden')
    expect(stubs.inspect).not.toHaveBeenCalled()
    stubs.requireRole.mockResolvedValue({ accountId, userId })
    stubs.assertAgentCapability.mockImplementationOnce(() => { throw new Error('capability denied') })
    await expect(POST(request({ mode: 'disabled', confirmation: 'DISABLE_TEST_AGENT_TASK_PILOT' }))).rejects.toThrow('capability denied')
    expect(stubs.change).not.toHaveBeenCalled()
  })

  it('requires explicit mode-specific confirmation and rejects malformed mode', async () => {
    expect((await POST(request({ mode: 'pilot' }))).status).toBe(400)
    expect((await POST(request({ mode: 'unknown', confirmation: 'ENABLE_TEST_AGENT_TASK_PILOT' }))).status).toBe(400)
    expect((await POST(request({ mode: 'disabled', confirmation: 'ENABLE_TEST_AGENT_TASK_PILOT' }))).status).toBe(400)
    expect(stubs.change).not.toHaveBeenCalled()
  })

  it('refuses activation while blockers exist, even with operator confirmation', async () => {
    stubs.inspect.mockResolvedValue(readiness('disabled', false))
    const res = await POST(request({ mode: 'pilot', confirmation: 'ENABLE_TEST_AGENT_TASK_PILOT' }))
    expect(res.status).toBe(409)
    expect((await res.json()).readiness.blockers).toEqual(['OUTBOUND_RECONCILIATION_REQUIRED'])
    expect(stubs.change).not.toHaveBeenCalled()
  })

  it('enables only via the existing atomic TEST cutover RPC with authenticated tenant identity', async () => {
    const res = await POST(request({
      mode: 'pilot', confirmation: 'ENABLE_TEST_AGENT_TASK_PILOT',
      accountId: 'attacker-account', actorId: 'attacker',
    }))
    expect(res.status).toBe(200)
    expect(stubs.change).toHaveBeenCalledWith({ accountId, mode: 'pilot', actorId: userId })
    expect((await res.json()).readiness.mode).toBe('pilot')
  })

  it('allows a confirmed stop even with preflight blockers or inconsistent state', async () => {
    stubs.inspect.mockResolvedValue(readiness('inconsistent', false))
    stubs.change.mockResolvedValue({
      mode: 'disabled', changed: true, before: readiness('inconsistent', false),
      after: readiness('disabled', false),
    })
    const res = await POST(request({ mode: 'disabled', confirmation: 'DISABLE_TEST_AGENT_TASK_PILOT' }))
    expect(res.status).toBe(200)
    expect(stubs.change).toHaveBeenCalledWith({ accountId, mode: 'disabled', actorId: userId })
  })

  it('fails closed and does not report success on an atomic RPC rejection', async () => {
    stubs.change.mockRejectedValue(new Error('sensitive database detail'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST(request({ mode: 'pilot', confirmation: 'ENABLE_TEST_AGENT_TASK_PILOT' }))
    spy.mockRestore()
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).not.toContain('sensitive database detail')
  })
})
