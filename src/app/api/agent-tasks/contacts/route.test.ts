import { beforeEach, describe, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => ({
  requireAgentCapability: vi.fn(),
  toErrorResponse: vi.fn((e: unknown) => { throw e }),
  from: vi.fn(),
  eligible: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireAgentCapability: stubs.requireAgentCapability,
  toErrorResponse: stubs.toErrorResponse,
}))
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({ from: stubs.from }),
}))
vi.mock('@/lib/services/coverage/selected-contact', () => ({
  checkCoverageSelectedContactEligibility: stubs.eligible,
}))

import { GET } from './route'

const acct = '11111111-1111-4111-8111-111111111111'
const contactId = '33333333-3333-4333-8333-333333333333'
const requestId = '44444444-4444-4444-8444-444444444444'

beforeEach(() => {
  vi.resetAllMocks()
  stubs.requireAgentCapability.mockResolvedValue({ accountId: acct })
  stubs.eligible.mockResolvedValue({ eligible: true })
  stubs.from.mockImplementation(() => {
    const q = {
      eq: vi.fn(), or: vi.fn(), select: vi.fn(), order: vi.fn(), limit: vi.fn(),
    }
    q.eq.mockReturnValue(q)
    q.or.mockReturnValue(q)
    q.select.mockReturnValue(q)
    q.order.mockReturnValue(q)
    q.limit.mockResolvedValue({
      data: [{ id: contactId, name: 'TEST Contact', phone: '+000000000000' }],
      error: null,
    })
    return q
  })
})

describe('Agent Task existing CRM contact picker API', () => {
  it('returns only minimal contact fields under account-scoped agent permissions', async () => {
    const response = await GET(new Request('http://localhost/api/agent-tasks/contacts?q=TEST'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.contacts).toEqual([{ id: contactId, name: 'TEST Contact', phone: '+000000000000' }])
    expect(stubs.requireAgentCapability).toHaveBeenCalledWith('agents.manage_tasks')
    const query = stubs.from.mock.results[0].value
    expect(query.eq).toHaveBeenCalledWith('account_id', acct)
    expect(JSON.stringify(body)).not.toMatch(/api_key|session_id|credential/)
  })

  it('checks selected supplier eligibility against the requested Coverage scope', async () => {
    const url = new URL('http://localhost/api/agent-tasks/contacts')
    url.searchParams.set('contactId', contactId)
    url.searchParams.set('coverageRequestId', requestId)
    const response = await GET(new Request(url))
    expect(response.status).toBe(200)
    expect((await response.json()).eligibility).toEqual({ eligible: true })
    expect(stubs.eligible).toHaveBeenCalledWith(expect.anything(), {
      accountId: acct, coverageRequestId: requestId, contactId,
    })
  })

  it('rejects malformed contact IDs and search injection before a DB read', async () => {
    const res = await GET(new Request('http://localhost/api/agent-tasks/contacts?contactId=bad'))
    expect(res.status).toBe(400)
    expect(stubs.from).not.toHaveBeenCalled()
    const searched = await GET(new Request(
      'http://localhost/api/agent-tasks/contacts?q=' + encodeURIComponent('TEST),id.eq.foreign'),
    ))
    expect(searched.status).toBe(200)
    const query = stubs.from.mock.results[0].value
    expect(query.or).toHaveBeenCalledWith(expect.not.stringContaining('id.eq'))
    expect(query.or).toHaveBeenCalledWith(expect.not.stringContaining(','))
  })
})
