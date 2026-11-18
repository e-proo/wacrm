import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  auth: vi.fn(), isTest: vi.fn(), rpc: vi.fn(),
}))

vi.mock('@/lib/whatsapp/transport/openwa/session-auth', () => ({
  requireOpenWASessionAdmin: h.auth,
}))
vi.mock('@/lib/whatsapp/transport/guardrails', () => ({
  isOpenWATestProject: h.isTest,
}))

import { GET, POST } from './route'

const ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CONNECTION = '11111111-2222-4333-8444-555555555555'
const MESSAGE = 'aaaa1111-2222-4333-8444-555555555555'
const ACTOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const URL = `http://localhost/api/whatsapp/connections/openwa/${CONNECTION}/outbound-review`
const context = { params: Promise.resolve({ connectionId: CONNECTION }) }
const pending = { items: [{ message_id: MESSAGE, created_at: '2026-11-17T21:28:39Z',
  sender_type: 'agent', content_type: 'text' }],
  unreviewed_count: 1, reviewed_uncertain_count: 0 }
const reviewed = { items: [], unreviewed_count: 0, reviewed_uncertain_count: 1 }
const NOTE = 'Inspected the WhatsApp conversation and chose no resend'
function request(body: Record<string, unknown>) {
  return new Request(URL, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}
function validBody() {
  return { action: 'acknowledge_no_resend', message_id: MESSAGE, finding: 'still_uncertain',
    note: NOTE, confirm_no_resend: true }
}
beforeEach(() => {
  vi.clearAllMocks()
  h.isTest.mockReturnValue(true)
  h.auth.mockResolvedValue({ accountId: ACCOUNT, user: { id: ACTOR },
    adminDb: { rpc: h.rpc } })
  h.rpc.mockImplementation(async (name: string) => {
    if (name === 'get_openwa_outbound_review_queue') return { data: pending, error: null }
    if (name === 'acknowledge_openwa_ambiguous_outbound')
      return { data: { updated: true }, error: null }
    return { data: null, error: { code: 'missing' } }
  })
})

describe('OpenWA ambiguous outbound operator review — TEST only', () => {
  it('rejects non-TEST before accessing auth or database', async () => {
    h.isTest.mockReturnValue(false)
    expect((await GET(new Request(URL), context)).status).toBe(403)
    expect((await POST(request(validBody()), context)).status).toBe(403)
    expect(h.auth).not.toHaveBeenCalled()
    expect(h.rpc).not.toHaveBeenCalled()
  })
  it('rejects missing session-admin authorization', async () => {
    h.auth.mockRejectedValue(new Error('secret auth detail'))
    const resp = await POST(request(validBody()), context)
    expect(resp.status).toBe(403)
    expect(JSON.stringify(await resp.json())).not.toContain('secret')
    expect(h.rpc).not.toHaveBeenCalled()
  })
  it('reads only the exact account/connection summary without recipient content', async () => {
    const response = await GET(new Request(URL), context)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject(pending)
    expect(h.rpc).toHaveBeenCalledWith('get_openwa_outbound_review_queue', {
      p_account_id: ACCOUNT, p_connection_id: CONNECTION,
    })
    expect(h.rpc).toHaveBeenCalledTimes(1)
  })
  it('never writes without reviewed finding, note, ID and explicit no-resend acknowledgement', async () => {
    for (const body of [
      { ...validBody(), confirm_no_resend: false },
      { ...validBody(), note: 'short' },
      { ...validBody(), message_id: 'invalid' },
      { ...validBody(), finding: 'delivered' },
      { ...validBody(), action: 'send' },
    ]) {
      const result = await POST(request(body), context)
      expect(result.status).toBe(400)
    }
    expect(h.rpc).not.toHaveBeenCalled()
  })
  it('records account-scoped review and refreshes the queue without calling transport', async () => {
    h.rpc.mockImplementation(async (name: string) => ({
      data: name === 'get_openwa_outbound_review_queue' ? reviewed : { updated: true },
      error: null,
    }))
    const response = await POST(request(validBody()), context)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      updated: true, message_still_uncertain: true, no_resend: true,
      unreviewed_count: 0, reviewed_uncertain_count: 1,
    })
    expect(h.rpc).toHaveBeenNthCalledWith(1, 'acknowledge_openwa_ambiguous_outbound', {
      p_account_id: ACCOUNT, p_connection_id: CONNECTION,
      p_message_id: MESSAGE, p_actor: ACTOR,
      p_finding: 'still_uncertain', p_review_note: NOTE, p_confirm_no_resend: true,
    })
    expect(h.rpc).toHaveBeenNthCalledWith(2, 'get_openwa_outbound_review_queue', {
      p_account_id: ACCOUNT, p_connection_id: CONNECTION,
    })
    expect(h.rpc).toHaveBeenCalledTimes(2)
  })
  it('requires paused transport and protects double-review without exposing data', async () => {
    h.rpc.mockResolvedValueOnce({ data: { updated: false, reason: 'stop_required' }, error: null })
    let response = await POST(request(validBody()), context)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'stop_required' })
    h.rpc.mockResolvedValueOnce({ data: { updated: false, reason: 'already_reviewed' }, error: null })
    response = await POST(request(validBody()), context)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'already_reviewed' })
  })
  it('does not disclose DB errors or resolve unknown tenant connections', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: 'sensitive-test-value' } })
    const response = await POST(request(validBody()), context)
    expect(response.status).toBe(502)
    expect(JSON.stringify(await response.json())).not.toContain('sensitive-test-value')
    h.rpc.mockResolvedValueOnce({ data: null, error: null })
    const missing = await GET(new Request(URL), context)
    expect(missing.status).toBe(404)
  })
})
