import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ requireRole: vi.fn(), rpc: vi.fn() }))
vi.mock('@/lib/auth/account', () => {
  class UnauthorizedError extends Error {}
  class ForbiddenError extends Error {}
  return { requireRole: h.requireRole, UnauthorizedError, ForbiddenError }
})
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: h.rpc }),
}))

import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account'
import { POST } from './route'

const ACCOUNT = 'bfa792bb-ab38-4ab9-b831-ecf32ce7ce93'
const USER = 'af61cbb1-60ba-4147-81c5-8bdebc4b692e'
const CONNECTION = '4fa7eac3-f5f5-4844-865e-4e7de1dd3239'
const REQUEST_ID = 'c829f45e-d061-4539-ac39-4384b16a86ea'
const context = (connectionId = CONNECTION) => ({ params: Promise.resolve({ connectionId }) })
const request = (payload: unknown, origin = 'http://localhost:3000', contentType = 'application/json') =>
  new Request('http://localhost:3000/api/whatsapp/connections/openwa/x/operational-activation', {
    method: 'POST',
    headers: { origin, 'content-type': contentType },
    body: JSON.stringify(payload),
  })

const enable = () => ({ action: 'enable', confirm_activation: true, expected_revision: 0, request_id: REQUEST_ID })
const disable = () => ({ action: 'disable', expected_revision: 1, request_id: REQUEST_ID })
const suspend = () => ({ action: 'suspend', expected_revision: 1, request_id: REQUEST_ID })

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
  vi.stubEnv('WACRM_W07_CONTROL_WRITES_ENABLED', '')
  h.requireRole.mockResolvedValue({ accountId: ACCOUNT, userId: USER, role: 'admin' })
  h.rpc.mockResolvedValue({ data: { updated: true, status: 'disabled', revision: 2 }, error: null })
})
afterEach(() => vi.unstubAllEnvs())

describe('W07-03 scoped connection activation API', () => {
  it('requires a verified admin identity and never calls SQL for an unauthorized user', async () => {
    h.requireRole.mockRejectedValueOnce(new UnauthorizedError())
    expect((await POST(request(enable()), context())).status).toBe(401)
    h.requireRole.mockRejectedValueOnce(new ForbiddenError())
    expect((await POST(request(enable()), context())).status).toBe(403)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('validates scoped connection UUID and blocks malicious origins or extra fields', async () => {
    expect((await POST(request(enable()), context('invalid-id'))).status).toBe(400)
    expect((await POST(request(enable(), 'https://evil.example'), context())).status).toBe(403)
    expect((await POST(request({ ...enable(), actor_id: USER }), context())).status).toBe(400)
    expect((await POST(request({ ...enable(), account_id: ACCOUNT }), context())).status).toBe(400)
    expect((await POST(request({ ...enable(), confirm_activation: false }), context())).status).toBe(400)
    expect((await POST(request({ ...enable(), expected_revision: -1 }), context())).status).toBe(400)
    expect((await POST(request(enable(), 'http://localhost:3000', 'text/plain'), context())).status).toBe(403)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('keeps enable disabled by default, but allows explicit disable and suspend for containment', async () => {
    expect((await POST(request(enable()), context())).status).toBe(409)
    expect(h.rpc).not.toHaveBeenCalled()

    const res = await POST(request(disable()), context())
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(await res.json()).toMatchObject({ applied: true, recorded_status: 'disabled', send_authorized: false })
    expect(h.rpc).toHaveBeenCalledWith('set_openwa_operational_activation', {
      p_account_id: ACCOUNT, p_connection_id: CONNECTION, p_actor: USER,
      p_status: 'disabled', p_expected_revision: 1, p_request_id: REQUEST_ID,
    })
    h.rpc.mockResolvedValueOnce({ data: { updated: true, status: 'suspended', revision: 3 }, error: null })
    expect((await POST(request(suspend()), context())).status).toBe(200)
    expect(h.rpc).toHaveBeenLastCalledWith('set_openwa_operational_activation', expect.objectContaining({
      p_status: 'suspended', p_account_id: ACCOUNT, p_connection_id: CONNECTION,
    }))
  })

  it('permits requested enable only with explicit stage opt-in and server-bound identity', async () => {
    vi.stubEnv('WACRM_W07_CONTROL_WRITES_ENABLED', 'true')
    h.rpc.mockResolvedValueOnce({ data: { updated: true, status: 'enabled', revision: 1 }, error: null })
    const res = await POST(request(enable()), context())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ applied: true, recorded_status: 'enabled',
      send_authorized: false, state_requires_refresh: true })
    expect(h.requireRole).toHaveBeenCalledWith('admin')
    expect(h.rpc).toHaveBeenCalledWith('set_openwa_operational_activation', {
      p_account_id: ACCOUNT, p_connection_id: CONNECTION, p_actor: USER,
      p_status: 'enabled', p_expected_revision: 0, p_request_id: REQUEST_ID,
    })
  })

  it('does not reveal other-account connection state and preserves conflicts and replay semantics', async () => {
    vi.stubEnv('WACRM_W07_CONTROL_WRITES_ENABLED', 'true')
    h.rpc.mockResolvedValueOnce({ data: { updated: false, reason: 'connection_scope_mismatch' }, error: null })
    const unknown = await POST(request(enable()), context())
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ code: 'connection_scope_mismatch', send_authorized: false })
    h.rpc.mockResolvedValueOnce({ data: { updated: false, reason: 'revision_conflict', revision: 5 }, error: null })
    const conflict = await POST(request(enable()), context())
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ code: 'revision_conflict', revision: 5 })
    h.rpc.mockResolvedValueOnce({ data: { updated: false, idempotent: true, status: 'enabled', revision: 1 }, error: null })
    const replay = await POST(request(enable()), context())
    expect(await replay.json()).toMatchObject({ replayed: true, send_authorized: false,
      state_requires_refresh: true })
  })

  it('fails closed on unavailable RPC or a malformed outcome without leaking private errors', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: 'DB_PRIVATE_SECRET' } })
    const res = await POST(request(disable()), context())
    expect(res.status).toBe(503)
    expect(JSON.stringify(await res.json())).not.toContain('DB_PRIVATE_SECRET')

    h.rpc.mockResolvedValueOnce({ data: { updated: true, status: 'delivered' }, error: null })
    const corrupted = await POST(request(disable()), context())
    expect(corrupted.status).toBe(503)
    expect(JSON.stringify(await corrupted.json())).not.toContain('delivered')
  })
})
