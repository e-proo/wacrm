import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  testProject: vi.fn(), admin: vi.fn(), rpc: vi.fn(),
}))
vi.mock('@/lib/whatsapp/transport/guardrails', () => ({
  isOpenWATestProject: mocks.testProject,
}))
vi.mock('@/lib/whatsapp/transport/openwa/session-auth', () => ({
  requireOpenWASessionAdmin: mocks.admin,
}))
import { POST } from './route'

const account = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const connection = '11111111-2222-4333-8444-555555555555'
const actor = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const id = (n: number) => '99999999-2222-4333-8444-' + n.toString(16).padStart(12, '0')
const context = { params: Promise.resolve({ connectionId: connection }) }
function request(ids: unknown, action: string = 'close_selected_unverified', confirm = true) {
  return new Request('https://test.example/reconciliation/bulk-disposition', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ job_ids: ids, action, confirm_no_resend: confirm }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.testProject.mockReturnValue(true)
  mocks.admin.mockResolvedValue({
    accountId: account, user: { id: actor }, adminDb: { rpc: mocks.rpc },
  })
  mocks.rpc.mockResolvedValue({ data: { updated: true, disposition: 'closed_unverified' }, error: null })
})

describe('OW14-W05 bounded multi-ACK admin settlement', () => {
  it('closes 23 explicitly selected cases using tenant-scoped RPC without sending', async () => {
    const ids = Array.from({ length: 23 }, (_, i) => id(i + 1))
    const response = await POST(request(ids), context)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ requested: 23, closed: 23, not_closed: 0,
      delivery_confirmed: false, outbound_resent: false })
    expect(body.results).toHaveLength(23)
    expect(mocks.rpc).toHaveBeenCalledTimes(23)
    for (const [i, item] of ids.entries()) {
      expect(body.results[i]).toEqual({ job_id: item, result: 'closed_unverified' })
      expect(mocks.rpc).toHaveBeenCalledWith('close_openwa_unmatched_ack', {
        p_account_id: account, p_connection_id: connection,
        p_job_id: item, p_actor: actor, p_finding: 'no_verified_evidence',
        p_gateway_status: null, p_confirm_no_resend: true,
      })
    }
  })
  it('keeps partial outcomes distinct: a local match, duplicate state and DB outage', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: {
      updated: false, reason: 'local_match_requires_reconciliation' }, error: null })
      .mockResolvedValueOnce({ data: { updated: false, reason: 'not_eligible_or_already_closed' }, error: null })
      .mockRejectedValueOnce(new Error('database-secret-PASSWORD'))
    const response = await POST(request([id(1),id(2),id(3),id(4)]), context)
    const body = await response.json()
    expect(body).toMatchObject({ requested:4, closed:1, not_closed:3,
      delivery_confirmed:false, outbound_resent:false })
    expect(body.results.map((x: {reason?:string})=>x.reason)).toEqual([
      'local_match_requires_reconciliation','not_eligible_or_already_closed','temporary_error',undefined,
    ])
    expect(JSON.stringify(body)).not.toContain('PASSWORD')
  })
  it('rejects the wrong environment and non-admin before RPC or mutation', async () => {
    mocks.testProject.mockReturnValueOnce(false)
    expect((await POST(request([id(1)]), context)).status).toBe(403)
    expect(mocks.admin).not.toHaveBeenCalled()
    mocks.admin.mockRejectedValueOnce(new Error('FORBIDDEN'))
    expect((await POST(request([id(1)]), context)).status).toBe(403)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it.each([
    [[], 'close_selected_unverified', true],
    [[id(1)], 'close_archive_observed', true],
    [[id(1)], 'close_selected_unverified', false],
    [[id(1),id(1)], 'close_selected_unverified', true],
    [[id(1).toUpperCase(),id(1)], 'close_selected_unverified', true],
    [Array.from({ length: 26 }, (_,i) => id(i + 1)), 'close_selected_unverified', true],
    [['invalid-uuid'], 'close_selected_unverified', true],
  ])('rejects invalid selection or missing acknowledgement', async (ids, action, confirm) => {
    const response = await POST(request(ids, action, confirm), context)
    expect(response.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('refuses wrong connection ID before actor lookup', async () => {
    expect((await POST(request([id(1)]), {
      params: Promise.resolve({ connectionId: 'wrong' }),
    })).status).toBe(400)
    expect(mocks.admin).not.toHaveBeenCalled()
  })
})
