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

import { GET, POST } from './route'

const acct = '11111111-1111-4111-8111-111111111111'
const contactId = '33333333-3333-4333-8333-333333333333'
const requestId = '44444444-4444-4444-8444-444444444444'

beforeEach(() => {
  vi.resetAllMocks()
  stubs.requireAgentCapability.mockResolvedValue({ accountId: acct })
  stubs.eligible.mockResolvedValue({ eligible: true })
  stubs.from.mockImplementation(() => {
    const q = {
      eq: vi.fn(), in: vi.fn(), or: vi.fn(), select: vi.fn(), order: vi.fn(), limit: vi.fn(),
    }
    q.eq.mockReturnValue(q)
    q.in.mockReturnValue(q)
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
    // One comma is the required PostgREST OR separator. The user-supplied
    // comma, parentheses, and query operator punctuation must be stripped.
    expect(query.or).toHaveBeenCalledWith(
      'name.ilike.%TESTideqforeign%,phone.ilike.%TESTideqforeign%',
    )
  })
  it('checks each selected contact without returning an unscoped phone list', async () => {
    const second = '55555555-5555-4555-8555-555555555555'
    const url = new URL('http://localhost/api/agent-tasks/contacts')
    url.searchParams.set('contactIds',[contactId,second].join(','))
    url.searchParams.set('coverageRequestId',requestId)
    const response = await GET(new Request(url))
    const data = await response.json()
    expect(response.status).toBe(200)
    expect(data.eligibilityById[contactId]).toEqual({eligible:true})
    expect(data.eligibilityById[second]).toEqual({
      eligible:false,reason:'contact_not_found',
    })
    const q = stubs.from.mock.results[0].value
    expect(q.eq).toHaveBeenCalledWith('account_id',acct)
    expect(q.in).toHaveBeenCalledWith('id',[contactId,second])
    expect(stubs.eligible).toHaveBeenCalledTimes(1)
  })
  it('does not query the CRM for malformed, duplicated or excessive recipient IDs', async () => {
    for (const ids of [
      contactId + ',' + contactId,
      contactId + ',invalid-phone',
      '',
      Array.from({length:21},(_,i) =>
        `00000000-0000-4000-8000-${String(i).padStart(12,'0')}`).join(','),
    ]) {
      const url = new URL('http://localhost/api/agent-tasks/contacts')
      url.searchParams.set('contactIds',ids)
      const response = await GET(new Request(url))
      expect(response.status).toBe(400)
    }
    expect(stubs.from).not.toHaveBeenCalled()
  })

})


describe('TEST phone-call opted-in prospect registration', () => {
  const connectionId = '66666666-6666-4666-8666-666666666666'
  const userId = '22222222-2222-4222-8222-222222222222'
  function request(body: Record<string, unknown>) {
    return new Request('http://localhost/api/agent-tasks/contacts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        phone: '+967700000001', name: 'New TEST Prospect',
        coverageRequestId: requestId,
        whatsappConnectionId: connectionId,
        consent_method: 'phone_call',
        whatsapp_opt_in_confirmed: true,
        ...body,
      }),
    })
  }

  it('rejects adding numbers without a specific WhatsApp opt-in, before database access', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://pqirsnfupofhulmewakq.supabase.co')
    try {
      const result = await POST(request({ whatsapp_opt_in_confirmed: false }))
      expect(result.status).toBe(400)
      expect(stubs.from).not.toHaveBeenCalled()
    } finally { vi.unstubAllEnvs() }
  })

  it('never registers prospects outside pinned TEST', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://other-project.supabase.co')
    try {
      const result = await POST(request({}))
      expect(result.status).toBe(403)
      expect(stubs.from).not.toHaveBeenCalled()
    } finally { vi.unstubAllEnvs() }
  })

  it('refuses conflicting legacy and normalized CRM contact identities without creating a new contact', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://pqirsnfupofhulmewakq.supabase.co')
    const conflicting = '88888888-8888-4888-8888-888888888888'
    const inserts = vi.fn()
    stubs.from.mockImplementation((table: string) => {
      let normalized = false
      const q = {
        select: () => q,
        eq: (field: string) => { if (field === 'phone_normalized') normalized = true; return q },
        in: () => q,
        is: () => q,
        maybeSingle: async () => ({ data: table === 'whatsapp_connections'
          ? { id: connectionId }
          : table === 'coverage_requests'
            ? { id: requestId, requester_contact_id: null }
            : null, error: null }),
        limit: async () => ({ data: table === 'contacts'
          ? [{ id: normalized ? contactId : conflicting, name: 'Old', phone: '+967700000001' }]
          : [], error: null }),
        insert: inserts,
      }
      return q
    })
    try {
      const result = await POST(request({}))
      expect(result.status).toBe(409)
      expect((await result.json()).code).toBe('DUPLICATE_CONTACT_PHONE_IDENTITY')
      expect(inserts).not.toHaveBeenCalled()
    } finally { vi.unstubAllEnvs() }
  })

  it('creates a tenant-owned CRM contact but does not send WhatsApp or authorize Pilot', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://pqirsnfupofhulmewakq.supabase.co')
    stubs.requireAgentCapability.mockResolvedValue({ accountId: acct, userId })
    let inserted: Record<string, unknown> | null = null
    stubs.from.mockImplementation((table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        in: () => query,
        is: () => query,
        maybeSingle: async () => ({
          data: table === 'whatsapp_connections' ? { id: connectionId }
            : table === 'coverage_requests' ? { id: requestId, requester_contact_id: null }
              : null,
          error: null,
        }),
        limit: async () => ({ data: [], error: null }),
        insert: (value: Record<string, unknown>) => {
          inserted = value
          return { select: () => ({ single: async () => ({
            data: { id: contactId, name: value.name, phone: value.phone },
            error: null,
          }) }) }
        },
      }
      return query
    })
    try {
      const response = await POST(request({}))
      const data = await response.json()
      expect(response.status).toBe(200)
      expect(data.contact.id).toBe(contactId)
      expect(inserted).toMatchObject({
        account_id: acct, user_id: userId,
        phone: '+967700000001', phone_normalized: '967700000001',
      })
      expect(stubs.from).not.toHaveBeenCalledWith('whatsapp_openwa_pilot_allowlist')
      expect(stubs.from).not.toHaveBeenCalledWith('messages')
    } finally { vi.unstubAllEnvs() }
  })
})
