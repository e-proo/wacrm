import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ requireAdmin: vi.fn() }))
vi.mock('@/lib/whatsapp/transport/openwa/session-auth', () => ({
  requireOpenWASessionAdmin: h.requireAdmin,
}))

import { POST } from './route'

function req(baseUrl = 'https://openwa.example.com', apiKey = 'secret-key') {
  return new Request('https://wacrm.example.com/api/whatsapp/connections/openwa/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ base_url: baseUrl, api_key: apiKey }),
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  h.requireAdmin.mockResolvedValue({ accountId: 'account-1' })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenWA read-only gateway check', () => {
  it('uses a GET with bearer authorization but never returns provider session details', async () => {
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      expect((args[0] as URL).pathname).toBe('/api/sessions')
      expect(args[1]?.method).toBe('GET')
      expect((args[1]?.headers as Record<string, string>).authorization).toBe('Bearer secret-key')
      return new Response(JSON.stringify([{ id: 'private-session-id', phone: 'private-phone' }]), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reachable: true })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects untrusted private HTTP destinations without sending a request', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const res = await POST(req('http://127.0.0.1:7000'))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('invalid_request')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports a DNS failure without exposing the private upstream exception', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('private.example.com token=should-not-leak'), { code: 'ENOTFOUND' }),
      })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const res = await POST(req())
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body).toEqual({
      reachable: false,
      error: 'OpenWA network request failed (DNS lookup failed)',
      code: 'retryable_provider_failure',
    })
    expect(JSON.stringify(body)).not.toContain('should-not-leak')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not probe the gateway for an unauthorized caller', async () => {
    h.requireAdmin.mockRejectedValue(new Error('access denied'))
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const res = await POST(req())
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({
      reachable: false, error: 'OpenWA gateway check failed', code: 'retryable_provider_failure',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
