import { describe, it, expect, vi, afterEach } from 'vitest'
import { providerFetch, toNetworkError } from './shared'
import { AiError } from '../types'
import type { AdapterContext } from './contract'

// Deterministic policy seams — providerFetch itself is tested for the
// WIRING (who gets gated, redirect refusal); the classification rules
// have their own suite in outbound/url-policy.test.ts.
vi.mock('../outbound/url-policy', () => ({
  validateUrl: (raw: string, opts: { allowPrivate?: boolean } = {}) => {
    const url = new URL(raw)
    if (url.protocol !== 'https:') {
      return { url, error: 'scheme', blockedReason: 'scheme_not_allowed' }
    }
    if (url.hostname === 'blocked.example') {
      return { url, error: 'policy', blockedReason: 'host_not_allowed' }
    }
    void opts
    return { url, error: null, blockedReason: null }
  },
  resolveTarget: async (url: URL) => {
    if (url.hostname === 'private.example') {
      return { host: url.hostname, port: 443, ips: [], allowed: false, reason: 'private ip' }
    }
    if (url.hostname === 'dead.example') {
      return { host: url.hostname, port: 443, ips: [], allowed: false, reason: 'did not resolve' }
    }
    return { host: url.hostname, port: 443, ips: ['93.184.216.34'], allowed: true, reason: '' }
  },
}))

const ctx = (over: Partial<AdapterContext> = {}): AdapterContext => ({
  apiKey: 'k',
  timeoutMs: 1000,
  ...over,
})

const mockJson = (status: number): Response =>
  ({ status, ok: status < 400, headers: new Headers(), json: async () => ({}) }) as Response

afterEach(() => vi.unstubAllGlobals())

describe('providerFetch — the custom-root gate', () => {
  it('fixed roots skip the policy entirely (legacy path unchanged)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJson(200))
    vi.stubGlobal('fetch', fetchMock)
    const res = await providerFetch(ctx(), 'https://api.openai.com/v1/x', {})
    expect(res.status).toBe(200)
    // Plain init passthrough — no manual redirect for fixed roots.
    expect(fetchMock.mock.calls[0][1].redirect).toBeUndefined()
  })

  it('custom host named in policy blocklist never reaches fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      providerFetch(ctx({ customEndpoint: true }), 'https://blocked.example/v1/', {}),
    ).rejects.toMatchObject({ code: 'endpoint_blocked' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('custom host resolving only to private space is refused', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      providerFetch(ctx({ customEndpoint: true }), 'https://private.example/v1/', {}),
    ).rejects.toBeInstanceOf(AiError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('custom host that does not resolve is refused (fail-closed)', async () => {
    await expect(
      providerFetch(ctx({ customEndpoint: true }), 'https://dead.example/v1/', {}),
    ).rejects.toMatchObject({ code: 'endpoint_blocked' })
  })

  it('custom root passes: request goes out with redirect: manual', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJson(200))
    vi.stubGlobal('fetch', fetchMock)
    const res = await providerFetch(
      ctx({ customEndpoint: true }),
      'https://api.b.ai/v1/chat/completions',
      {},
    )
    expect(res.status).toBe(200)
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual')
  })

  it('custom root redirecting is refused (3xx never followed)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJson(302))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      providerFetch(ctx({ customEndpoint: true }), 'https://api.b.ai/v1/', {}),
    ).rejects.toMatchObject({ code: 'endpoint_blocked' })
  })
})

describe('toNetworkError — classification preservation', () => {
  it('keeps an already-classified outbound AiError intact', () => {
    const original = new AiError('blocked before transport', {
      code: 'endpoint_blocked',
      status: 502,
    })
    expect(toNetworkError(original)).toBe(original)
    expect(toNetworkError(original)).toMatchObject({ code: 'endpoint_blocked', status: 502 })
  })

  it('still maps ordinary fetch failures to network_error', () => {
    expect(toNetworkError(new Error('socket closed'))).toMatchObject({
      code: 'network_error',
      status: 502,
    })
  })
})
