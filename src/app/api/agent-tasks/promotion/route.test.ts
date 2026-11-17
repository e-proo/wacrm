import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => ({
  auth: vi.fn(), testProject: vi.fn(), start: vi.fn(),
  from: vi.fn(), toError: vi.fn((error: unknown) => { throw error }),
}))
vi.mock('@/lib/auth/account', () => ({
  requireAgentCapability: stubs.auth,
  toErrorResponse: stubs.toError,
}))
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({ from: stubs.from }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => { throw new Error('unexpected rate limit') },
  RATE_LIMITS: { adminAction: {} },
}))
vi.mock('@/lib/whatsapp/transport/guardrails', () => ({
  isOpenWATestProject: stubs.testProject,
}))
vi.mock('@/lib/services/service-catalog/agent-task-service', () => ({
  ServicePromotionTaskError: class ServicePromotionTaskError extends Error {
    code = 'PROMOTION_TEST_ERROR'
    status = 409
  },
  startServicePromotionTask: stubs.start,
}))

import { GET, POST } from './route'

const accountId = '00000000-0000-4000-8000-000000000001'
const userId = '00000000-0000-4000-8000-000000000002'
const serviceId = '00000000-0000-4000-8000-000000000003'
const agentId = '00000000-0000-4000-8000-000000000004'
const connectionId = '00000000-0000-4000-8000-000000000005'
const submissionId = '00000000-0000-4000-8000-000000000006'
const reviewFingerprint = 'f'.repeat(64)

function request(payload: unknown) {
  return new Request('http://localhost/api/agent-tasks/promotion', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}
function validPayload() {
  return {
    serviceId, agentId, connectionId, submissionId, fingerprint: reviewFingerprint,
    reviewedAt: new Date().toISOString(),
    consentAcknowledged: true, approvalAcknowledged: true,
    accountId: 'forged-account', actorUserId: 'forged-user',
  }
}
function fakeFrom(table: string) {
  const data = table === 'services' ? [{ id: serviceId, name: 'TEST Service', code: 'TEST', status: 'active' }]
    : table === 'ai_agents' ? [{ id: agentId, name: 'Promo', status: 'active',
      published_revision_id: agentId }]
      : table === 'whatsapp_connections' ? [{ id: connectionId, display_name: 'Meta TEST',
        provider: 'meta_cloud', status: 'connected', archived_at: null }]
        : table === 'ai_agent_revisions' ? [{ id: agentId, outreach_policy: {
          bindings: [{ taskType: 'services.promotion', taskTypeVersion: 2 }],
        } }]
          : []
  const chain = {
    select: () => chain, eq: () => chain, in: () => chain,
    order: () => chain, limit: async () => ({ data, error: null }),
  }
  return chain
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.WACRM_SERVICE_PROMOTION_PILOT_ALLOW_LIVE
  stubs.auth.mockResolvedValue({ accountId, userId })
  stubs.testProject.mockReturnValue(true)
  stubs.from.mockImplementation(fakeFrom)
  stubs.start.mockResolvedValue({
    taskId: submissionId, revisionId: agentId, agentId, created: true,
  })
})
afterEach(() => { delete process.env.WACRM_SERVICE_PROMOTION_PILOT_ALLOW_LIVE })

describe('Service Promotion operator API', () => {
  it('lists only account-owned entities and shows preview-only by default', async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.mode).toBe('preview_only')
    expect(data.launchEnabled).toBe(false)
    expect(data.agents[0].promotionV2).toBe(true)
    expect(data.connections[0].provider).toBe('meta_cloud')
    expect(stubs.auth).toHaveBeenCalledWith('agents.manage_tasks')
    expect(stubs.auth).toHaveBeenCalledWith('agents.manage_outreach')
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(stubs.start).not.toHaveBeenCalled()
  })

  it('fails closed before launch when technical/live gate has not been enabled', async () => {
    const response = await POST(request(validPayload()))
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe('SERVICE_PROMOTION_LIVE_ACCEPTANCE_NOT_AUTHORIZED')
    expect(stubs.start).not.toHaveBeenCalled()
    expect(stubs.from).not.toHaveBeenCalled()
  })

  it('rejects missing approval or consent even with TEST authorization', async () => {
    process.env.WACRM_SERVICE_PROMOTION_PILOT_ALLOW_LIVE = '1'
    const res = await POST(request({ ...validPayload(), consentAcknowledged: false }))
    expect(res.status).toBe(400)
    expect(stubs.start).not.toHaveBeenCalled()
  })

  it('passes the exact reviewed IDs but only server-resolved tenant/actor', async () => {
    process.env.WACRM_SERVICE_PROMOTION_PILOT_ALLOW_LIVE = '1'
    const res = await POST(request(validPayload()))
    expect(res.status).toBe(201)
    expect(stubs.start).toHaveBeenCalledWith({
      accountId, actorUserId: userId, serviceId, agentId,
      review: {
        connectionId, submissionId, fingerprint: reviewFingerprint,
        reviewedAt: expect.any(String),
        consentAcknowledged: true, approvalAcknowledged: true,
      },
    })
  })

  it('rejects a client-selected recipient list and non-TEST launch', async () => {
    process.env.WACRM_SERVICE_PROMOTION_PILOT_ALLOW_LIVE = '1'
    const rejected = await POST(request({
      ...validPayload(), targetContactIds: [serviceId],
    }))
    expect(rejected.status).toBe(400)
    stubs.testProject.mockReturnValue(false)
    expect((await POST(request(validPayload()))).status).toBe(403)
    expect(stubs.start).not.toHaveBeenCalled()
  })
})
