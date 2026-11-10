import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  rpc: vi.fn(),
  logout: vi.fn(),
  credentials: vi.fn(),
}))

vi.mock('@/lib/whatsapp/transport/openwa/session-auth', () => ({
  requireOpenWASessionAdmin: h.auth,
}))
vi.mock('@/lib/whatsapp/transport/openwa/session-lifecycle', () => ({
  logoutOpenWAConnection: h.logout,
  reconnectOpenWAConnection: vi.fn(),
  refreshOpenWAConnectionStatus: vi.fn(),
}))
vi.mock('@/lib/whatsapp/transport/openwa/credentials', () => ({
  resolveOpenWAClient: h.credentials,
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: vi.fn() }))

import { DELETE, POST } from './route'

const CONNECTION = '11111111-2222-4333-8444-555555555555'
const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
function context(id = CONNECTION) {
  return { params: Promise.resolve({ connectionId: id }) }
}
function request(action = 'remove_from_wacrm') {
  return new Request('https://localhost/api/whatsapp/connections/openwa/' + CONNECTION, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  })
}

describe('OpenWA session removal from WACRM', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.rpc.mockResolvedValue({ data: 'archived', error: null })
    h.auth.mockResolvedValue({
      accountId: ACCOUNT, user: { id: ACTOR },
      adminDb: { rpc: h.rpc },
    })
  })

  it('archives only the authenticated tenant connection and never calls OpenWA logout', async () => {
    const response = await POST(request(), context())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ removed: true, already_removed: false })
    expect(h.rpc).toHaveBeenCalledWith('archive_openwa_connection', {
      p_account_id: ACCOUNT, p_connection_id: CONNECTION, p_actor_id: ACTOR,
    })
    expect(h.logout).not.toHaveBeenCalled()
    expect(h.credentials).not.toHaveBeenCalled()
  })

  it.each([
    ['pending_sends', 'Pending OpenWA sends'],
    ['pending_webhooks', 'Unfinished signed OpenWA events'],
  ])('blocks removal while %s are unresolved', async (code, description) => {
    h.rpc.mockResolvedValue({ data: code, error: null })
    const response = await POST(request(), context())
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.code).toBe(code)
    expect(body.error).toContain(description)
    expect(h.logout).not.toHaveBeenCalled()
  })

  it('handles an already archived connection idempotently', async () => {
    h.rpc.mockResolvedValue({ data: 'already_archived', error: null })
    const response = await POST(request(), context())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ removed: true, already_removed: true })
  })

  it('returns 404 for a missing or cross-account connection', async () => {
    h.rpc.mockResolvedValue({ data: 'not_found', error: null })
    const response = await POST(request(), context())
    expect(response.status).toBe(404)
    expect((await response.json()).code).toBe('not_found')
  })

  it('requires server-admin authorization and does not touch the database on denial', async () => {
    h.auth.mockRejectedValue(new Error('Private auth token should never leak'))
    const response = await POST(request(), context())
    expect(response.status).toBe(502)
    expect(JSON.stringify(await response.json())).not.toContain('Private auth token')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('rejects invalid connection IDs before invoking the archival RPC', async () => {
    const response = await POST(request(), context('../bad'))
    expect(response.status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('never exposes provider or SQL errors to the user', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '42P01', message: 'secret credentials and hostname' } })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await POST(request(), context())
      expect(response.status).toBe(502)
      expect((await response.json()).code).toBe('archive_failed')
      expect(JSON.stringify(await response.json().catch(() => ({})))).not.toContain('secret credentials')
      expect(h.logout).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })

  it('retains historical DELETE logout behavior (distinct from removal)', async () => {
    h.logout.mockResolvedValue({ status: 'logged_out' })
    const response = await DELETE(new Request('https://localhost/', { method: 'DELETE' }), context())
    expect(response.status).toBe(200)
    expect(h.logout).toHaveBeenCalledTimes(1)
    expect(h.rpc).not.toHaveBeenCalled()
  })
})
