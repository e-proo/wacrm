import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAgentCapability: vi.fn(),
  toErrorResponse: vi.fn(),
  getHandler: vi.fn(),
  validate: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  inspectCampaign: vi.fn(),
  assertFresh: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireAgentCapability: mocks.requireAgentCapability,
  toErrorResponse: mocks.toErrorResponse,
}))
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: mocks.rpc, from: mocks.from }),
}))
vi.mock('@/lib/ai/tasks/current-platform', () => ({
  CURRENT_AGENT_TASK_TRIGGER_REGISTRY: {
    get: mocks.getHandler,
  },
}))
vi.mock('@/lib/services/service-catalog/promotion-campaign-review', () => ({
  inspectServicePromotionCampaign: mocks.inspectCampaign,
  assertPromotionReviewFresh: mocks.assertFresh,
  ServicePromotionReviewError: class ServicePromotionReviewError extends Error {
    constructor(code: string) { super(code) }
  },
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response('', { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}))

import { GET, POST } from './route'

const accountId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const agentId = '33333333-3333-4333-8333-333333333333'
const sourceId = '44444444-4444-4444-8444-444444444444'
const revisionId = '55555555-5555-4555-8555-555555555555'
const triggerId = '66666666-6666-4666-8666-666666666666'
const submissionId = '77777777-7777-4777-8777-777777777777'
const form = {
  accountId: 'attacker-account',
  agentId,
  submissionId,
  taskType: 'coverage.sourcing',
  taskTypeVersion: 2,
  triggerKind: 'schedule',
  scheduleKind: 'once',
  nextFireAt: '2026-11-17T20:00:00Z',
  coverageRequestId: sourceId,
  overlapPolicy: 'skip',
  whatsappConnectionId: '88888888-8888-4888-8888-888888888888',
  selectedContactIds: [],
}

function post(body: unknown) {
  return POST(new Request('http://localhost/api/agent-tasks/triggers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-17T19:00:00Z'))
  vi.clearAllMocks()
  mocks.requireAgentCapability.mockResolvedValue({ accountId, userId })
  mocks.getHandler.mockReturnValue({ validate: mocks.validate })
  mocks.inspectCampaign.mockResolvedValue({
    blockers: [],
    fingerprint: 'a'.repeat(64),
    agent: { revisionId }, connection: { id: '88888888-8888-4888-8888-888888888888', provider: 'meta_cloud' },
    audience: { ids: [sourceId], count: 1 },
  })
  mocks.rpc.mockResolvedValue({ data: triggerId, error: null })
  mocks.toErrorResponse.mockImplementation(() => new Response(JSON.stringify({ error: 'Denied' }), {
    status: 403, headers: { 'content-type': 'application/json' },
  }))
  mocks.from.mockImplementation((table: string) => ({
    select() { return this },
    eq() { return this },
    async maybeSingle() {
      if (table === 'ai_agents') return {
        data: { id: agentId, status: 'active', published_revision_id: revisionId }, error: null,
      }
      if (table === 'coverage_requests') return { data: { id: sourceId }, error: null }
      if (table === 'whatsapp_connections') return {
        data: { id: form.whatsappConnectionId, provider: 'meta_cloud',
          status: 'connected', archived_at: null }, error: null
      }
      return { data: null, error: null }
    },
  }))
})

afterEach(() => vi.useRealTimers())

describe('SCH-2 reviewed scheduling API', () => {
  it('scopes source and reviewed policy creation to the authorized account, not request fields', async () => {
    const result = await post(form)
    expect(result.status).toBe(201)
    expect((await result.json()).status).toBe('paused')
    expect(mocks.requireAgentCapability).toHaveBeenCalledWith('agents.manage_tasks')
    expect(mocks.rpc).toHaveBeenCalledWith('create_reviewed_agent_task_trigger', expect.objectContaining({
      p_account_id: accountId,
      p_actor: userId,
      p_agent_id: agentId,
      p_approved_revision_id: revisionId,
      p_config: { coverageRequestId: sourceId,
        whatsappConnectionId: form.whatsappConnectionId, selectedContactIds: [] },
      p_idempotency_key: 'sch2:' + submissionId,
      p_overlap_policy: 'skip',
    }))
    expect(mocks.from).toHaveBeenCalledWith('ai_agents')
    expect(mocks.from).toHaveBeenCalledWith('coverage_requests')
  })

  it('rejects malformed source and never reaches the service-role create RPC', async () => {
    const response = await post({ ...form, coverageRequestId: 'foreign-id' })
    expect(response.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('fails closed when the subject cannot be found in the authorized account', async () => {
    mocks.from.mockImplementation((table: string) => ({
      select() { return this }, eq() { return this },
      async maybeSingle() {
        if (table === 'ai_agents') return {
          data: { id: agentId, status: 'active', published_revision_id: revisionId }, error: null,
        }
        return { data: null, error: null }
      },
    }))
    const response = await post(form)
    expect(response.status).toBe(404)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('blocks the route before querying if admin capability is denied', async () => {
    mocks.requireAgentCapability.mockRejectedValue(new Error('Forbidden'))
    const response = await GET()
    expect(response.status).toBe(403)
    expect(mocks.from).not.toHaveBeenCalled()
  })
})

describe('SCH-3: promotion V2 scheduled review', () => {
  const review = {
    fingerprint: 'a'.repeat(64), reviewedAt: '2026-11-17T19:00:00Z',
    consentAcknowledged: true, approvalAcknowledged: true,
    recurringAcknowledged: true,
  }
  const campaign = {
    agentId, submissionId, taskType: 'services.promotion', taskTypeVersion: 2,
    serviceId: sourceId, connectionId: form.whatsappConnectionId,
    triggerKind: 'schedule', scheduleKind: 'recurring',
    nextFireAt: '2026-11-17T20:00:00Z', intervalMinutes: 60,
    overlapPolicy: 'skip', promotionReview: review,
  }

  it('freezes server-derived campaign cohort/connection/revision and only creates PAUSED trigger', async () => {
    mocks.from.mockImplementation((table: string) => ({
      select(){return this},eq(){return this},
      async maybeSingle(){
        if (table === 'ai_agents') return { data: {
          id: agentId, status: 'active', published_revision_id: revisionId }, error: null }
        if (table === 'services') return { data: { id: sourceId }, error: null }
        return { data: null, error: null }
      },
    }))
    const response = await post(campaign)
    expect(response.status).toBe(201)
    expect(mocks.requireAgentCapability).toHaveBeenCalledWith('agents.manage_outreach')
    expect(mocks.inspectCampaign).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ accountId, serviceId: sourceId,
        agentId, connectionId: form.whatsappConnectionId }))
    expect(mocks.assertFresh).toHaveBeenCalled()
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    expect(mocks.rpc).toHaveBeenCalledWith('create_reviewed_agent_task_trigger',
      expect.objectContaining({
        p_account_id: accountId, p_actor: userId, p_task_type_version: 2,
        p_config: expect.objectContaining({
          serviceId: sourceId,
          promotionReview: expect.objectContaining({
            approvedBy: userId, approvedRevisionId: revisionId,
            connectionId: form.whatsappConnectionId,
            fingerprint: review.fingerprint,
            frozenContactIds: [sourceId],
            approvalAcknowledged: true,
          }),
        }),
      }))
  })

  it('denies unapproved, changed or obstructed campaigns before a Task or trigger RPC', async () => {
    for (const invalid of [
      { ...campaign, promotionReview: { ...review, consentAcknowledged: false } },
      { ...campaign, promotionReview: { ...review, recurringAcknowledged: false } },
    ]) {
      const res = await post(invalid)
      expect(res.status).toBe(400)
    }
    expect(mocks.rpc).not.toHaveBeenCalled()
    mocks.inspectCampaign.mockResolvedValueOnce({
      blockers: ['SERVICE_PROMOTION_CONTACT_BLOCKED'],
      fingerprint: 'a'.repeat(64),
      agent: { revisionId },
      connection: { id: form.whatsappConnectionId, provider: 'meta_cloud' },
      audience: { ids: [sourceId], count: 1 },
    })
    expect((await post(campaign)).status).toBe(409)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('does not allow the deprecated promotion V1 scheduler', async () => {
    expect((await post({ ...campaign, taskTypeVersion: 1 })).status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
