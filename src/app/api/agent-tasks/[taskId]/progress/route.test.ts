import { beforeEach, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => ({
  requireAgentCapability: vi.fn(),
  from: vi.fn(),
}))
vi.mock('@/lib/auth/account', () => ({
  requireAgentCapability: stubs.requireAgentCapability,
  toErrorResponse: (error: unknown) => { throw error },
}))
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({ from: stubs.from }),
}))
import { GET } from './route'

const acct = '11111111-1111-4111-8111-111111111111'
const taskId = '22222222-2222-4222-8222-222222222222'
const first = '33333333-3333-4333-8333-333333333333'
const second = '44444444-4444-4444-8444-444444444444'
const targetId = '55555555-5555-4555-8555-555555555555'
const messageId = '66666666-6666-4666-8666-666666666666'
const ctx = { params: Promise.resolve({ taskId }) }

function query(name: string) {
  const data: Record<string, unknown[]> = {
    ai_agent_tasks: [{
      id: taskId, task_type: 'coverage.sourcing', status: 'running',
      target_policy: { selectedContactIds: [second, first] },
    }],
    contacts: [{ id: first, name: 'Test contact', phone: '+123456' }, { id: second, name: 'Test 2', phone: '+456789' }],
    ai_agent_task_targets: [{
      id: targetId, contact_id: first, status: 'awaiting_reply', attempt_count: 1,
      skip_reason: null, failure_code: null, last_outbound_message_id: messageId,
    }],
    ai_agent_task_outbound_messages: [{
      task_target_id: targetId, status: 'sent', provider: 'openwa', error_code: null,
    }],
  }
  const q = {
    select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(async () => ({ data: data[name]?.[0] ?? null, error: null })),
    limit: vi.fn(async () => ({ data: data[name] ?? [], error: null })),
  }
  return q
}

beforeEach(() => {
  vi.clearAllMocks()
  stubs.requireAgentCapability.mockResolvedValue({ accountId: acct })
  stubs.from.mockImplementation(query)
})

describe('SOF-66 per-recipient progress, read-only and tenant-scoped', () => {
  it('preserves explicit selection order and does not mark unmaterialized recipients as sent', async () => {
    const response = await GET(new Request('http://localhost'), ctx)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.recipients.map((r: { contactId: string }) => r.contactId)).toEqual([second, first])
    expect(body.recipients[0]).toMatchObject({
      targetStatus: null, outboundStatus: null, attemptCount: 0,
    })
    expect(body.recipients[1]).toMatchObject({
      targetStatus: 'awaiting_reply', outboundStatus: 'sent', attemptCount: 1,
    })
    const queries = stubs.from.mock.results.map(({ value }) => value)
    expect(queries).toHaveLength(4)
    expect(queries[3].in).toHaveBeenCalledWith('task_target_id', [targetId])
    for (const q of queries) expect(q.eq).toHaveBeenCalledWith('account_id', acct)
    expect(stubs.requireAgentCapability).toHaveBeenCalledWith('agents.manage_tasks')
  })

  it('rejects malformed Task IDs before accessing CRM data', async () => {
    const response = await GET(new Request('http://localhost'), {
      params: Promise.resolve({ taskId: 'untrusted' }),
    })
    expect(response.status).toBe(400)
    expect(stubs.from).not.toHaveBeenCalled()
  })

  it('never reports a Task from a different tenant', async () => {
    stubs.from.mockImplementation((table: string) => {
      const q = query(table)
      if (table === 'ai_agent_tasks') q.maybeSingle.mockResolvedValue({ data: null, error: null })
      return q
    })
    const response = await GET(new Request('http://localhost'), ctx)
    expect(response.status).toBe(404)
    expect(stubs.from).toHaveBeenCalledTimes(1)
  })
})
