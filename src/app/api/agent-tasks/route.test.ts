import { beforeEach, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => ({
  requireAgentCapability: vi.fn(),
  toErrorResponse: vi.fn((error: unknown) => {
    throw error
  }),
  startCoverageSourcingTask: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  eligibility: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireAgentCapability: stubs.requireAgentCapability,
  toErrorResponse: stubs.toErrorResponse,
}))

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: stubs.rpc, from: stubs.from }),
}))

vi.mock('@/lib/services/coverage/agent-task-service', () => ({
  startCoverageSourcingTask: stubs.startCoverageSourcingTask,
  CoverageSourcingTaskError: class CoverageSourcingTaskError extends Error {
    code = 'TEST'
    status = 409
  },
}))

vi.mock('@/lib/services/coverage/selected-contact', () => ({
  checkCoverageSelectedContactEligibility: stubs.eligibility,
}))

import { POST, PATCH } from './route'

const accountId = '11111111-1111-4111-8111-111111111111'
const agentId = '22222222-2222-4222-8222-222222222222'
const requestId = '33333333-3333-4333-8333-333333333333'
const connectionId = '44444444-4444-4444-8444-444444444444'
const taskId = '55555555-5555-4555-8555-555555555555'
const contactId = '77777777-7777-4777-8777-777777777777'
const userId = '66666666-6666-4666-8666-666666666666'

function jsonRequest(method: 'POST' | 'PATCH', data: unknown): Request {
  return new Request('http://localhost/api/agent-tasks', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  stubs.requireAgentCapability.mockResolvedValue({ accountId, userId })
  stubs.startCoverageSourcingTask.mockResolvedValue({
    taskId, agentId, revisionId: agentId, created: true,
  })
  stubs.rpc.mockResolvedValue({ data: { updated: true, task_id: taskId }, error: null })
  stubs.eligibility.mockResolvedValue({ eligible: true })
  stubs.from.mockReturnValue({
    select() { return this }, eq() { return this },
    async maybeSingle() { return { data: {
      task_type: 'coverage.sourcing',
      task_context: { coverageRequestId: requestId },
      target_policy: { coverageRegionIds: [] },
    }, error: null } },
  })
})

describe('per-Task WhatsApp configuration API (SOF-64)', () => {
  it('accepts the exact Task connection and refuses client-supplied tenant identities', async () => {
    const response = await POST(jsonRequest('POST', {
      accountId: 'other-tenant', actorUserId: 'other-user',
      agentId, coverageRequestId: requestId,
      whatsappConnectionId: connectionId,
      maxTargets: 1, maxAttemptsPerTarget: 1,
    }))
    expect(response.status).toBe(201)
    expect(stubs.requireAgentCapability).toHaveBeenCalledWith('agents.manage_tasks')
    expect(stubs.startCoverageSourcingTask).toHaveBeenCalledWith({
      accountId, actorUserId: userId,
      agentId, coverageRequestId: requestId,
      whatsappConnectionId: connectionId,
      maxTargets: 1, maxAttemptsPerTarget: 1,
    })
  })

  it('allows explicit conversation-route mode but never a blank implicit default', async () => {
    const accepted = await POST(jsonRequest('POST', {
      agentId, coverageRequestId: requestId,
      whatsappConnectionId: null,
      maxTargets: 1, maxAttemptsPerTarget: 1,
    }))
    expect(accepted.status).toBe(201)
    const denied = await POST(jsonRequest('POST', {
      agentId, coverageRequestId: requestId,
      maxTargets: 1, maxAttemptsPerTarget: 1,
    }))
    expect(denied.status).toBe(400)
  })

  it('rejects invalid UUID and send-cap inputs without touching a task', async () => {
    const response = await POST(jsonRequest('POST', {
      agentId, coverageRequestId: requestId,
      whatsappConnectionId: 'foreign-creds',
      maxTargets: 100000, maxAttemptsPerTarget: 99,
    }))
    expect(response.status).toBe(400)
    expect(stubs.startCoverageSourcingTask).not.toHaveBeenCalled()
  })

  it('edits pending Task only using a tenant/admin-scoped server RPC', async () => {
    const response = await PATCH(jsonRequest('PATCH', {
      taskId, whatsappConnectionId: connectionId,
      selectedContactId: null,
      maxTargets: 1, maxAttemptsPerTarget: 1,
      accountId: 'foreign',
    }))
    expect(response.status).toBe(200)
    expect(stubs.rpc).toHaveBeenCalledWith('update_pending_agent_task_target', {
      p_account_id: accountId,
      p_task_id: taskId,
      p_actor_user_id: userId,
      p_connection_id: connectionId,
      p_selected_contact_id: null,
      p_max_targets: 1,
      p_max_attempts_per_target: 1,
    })
  })

  it('does not report a blocked post-start session change as successful', async () => {
    stubs.rpc.mockResolvedValue({
      data: { updated: false, reason: 'task_already_started' }, error: null,
    })
    const response = await PATCH(jsonRequest('PATCH', {
      taskId, whatsappConnectionId: connectionId,
      selectedContactId: null,
      maxTargets: 1, maxAttemptsPerTarget: 1,
    }))
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('task_already_started')
  })
  it('preserves the explicit selected CRM contact in the bounded task creation payload', async () => {
    const response = await POST(jsonRequest('POST', {
      agentId, coverageRequestId: requestId, whatsappConnectionId: connectionId,
      selectedContactId: contactId, maxTargets: 1, maxAttemptsPerTarget: 1,
    }))
    expect(response.status).toBe(201)
    expect(stubs.startCoverageSourcingTask).toHaveBeenCalledWith(expect.objectContaining({
      accountId, selectedContactId: contactId, maxTargets: 1,
    }))
  })

  it('rejects a selected contact outside the account or not eligible for Coverage', async () => {
    stubs.eligibility.mockResolvedValue({ eligible: false, reason: 'contact_not_found' })
    const response = await PATCH(jsonRequest('PATCH', {
      taskId, whatsappConnectionId: connectionId,
      selectedContactId: contactId, maxTargets: 1, maxAttemptsPerTarget: 1,
    }))
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('COVERAGE_CONTACT_NOT_ELIGIBLE')
    expect(stubs.rpc).not.toHaveBeenCalled()
  })

  it('only edits a pending task after selected supplier domain validation', async () => {
    const response = await PATCH(jsonRequest('PATCH', {
      taskId, whatsappConnectionId: connectionId,
      selectedContactId: contactId, maxTargets: 1, maxAttemptsPerTarget: 1,
      accountId: 'wrong-tenant',
    }))
    expect(response.status).toBe(200)
    expect(stubs.eligibility).toHaveBeenCalledWith(expect.anything(), {
      accountId, coverageRequestId: requestId, contactId,
      coverageRegionIds: [],
    })
    expect(stubs.rpc).toHaveBeenCalledWith('update_pending_agent_task_target',
      expect.objectContaining({
        p_account_id: accountId, p_actor_user_id: userId,
        p_selected_contact_id: contactId,
      }))
  })

  it('rejects malformed selected contact IDs without invoking the Task creator', async () => {
    const response = await POST(jsonRequest('POST', {
      agentId, coverageRequestId: requestId, whatsappConnectionId: connectionId,
      selectedContactId: 'foreign-contact', maxTargets: 1, maxAttemptsPerTarget: 1,
    }))
    expect(response.status).toBe(400)
    expect(stubs.startCoverageSourcingTask).not.toHaveBeenCalled()
  })

})
