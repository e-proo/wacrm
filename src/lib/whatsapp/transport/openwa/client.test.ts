import { describe, expect, it, vi } from 'vitest'
import { OpenWAClient, redactOpenWAValue, validateOpenWABaseUrl } from './client'
import { WhatsAppTransportError } from '../types'

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('OpenWAClient', () => {
  it('rejects insecure and private service URLs by default', () => {
    expect(() => validateOpenWABaseUrl('http://openwa.example.com')).toThrow(WhatsAppTransportError)
    expect(() => validateOpenWABaseUrl('https://127.0.0.1:3000')).toThrow(WhatsAppTransportError)
    expect(() => validateOpenWABaseUrl('https://192.168.1.10')).toThrow(WhatsAppTransportError)
  })

  it('permits an explicitly allowlisted private host for controlled self-hosting', () => {
    expect(validateOpenWABaseUrl('https://10.0.0.5:8443', ['10.0.0.5']).origin).toBe('https://10.0.0.5:8443')
  })

  it('adds auth, correlation and idempotency headers without exposing them in results', async () => {
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const init = args[1]
      const headers = init?.headers as Record<string, string>
      expect(headers.authorization).toBe('Bearer secret-key')
      expect(headers['x-correlation-id']).toBe('corr-1')
      expect(headers['idempotency-key']).toBe('idem-1')
      return response(200, { id: 'msg-1', token: 'must-not-leak' })
    }) as unknown as typeof fetch

    const client = new OpenWAClient({ baseUrl: 'https://openwa.example.com', apiKey: 'secret-key', fetchImpl })
    const result = await client.sendText({ sessionId: 's1', to: '967700000000', text: 'hello', idempotencyKey: 'idem-1' }, 'corr-1')
    expect(result.providerMessageId).toBe('msg-1')
    expect(result.raw?.token).toBe('[REDACTED]')
  })

  it('supports create, QR, reconnect and logout session primitives', async () => {
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const target = args[0] as URL
      const init = args[1]
      if (target.pathname.endsWith('/sessions') && init?.method === 'POST') {
        return response(200, { sessionId: 's1', status: 'waiting_qr', qr: 'secret-qr' })
      }
      if (target.pathname.endsWith('/sessions/s1/qr')) return response(200, { qr: 'secret-qr', expiresAt: '2026-10-24T00:00:00Z' })
      if (target.pathname.endsWith('/sessions/s1/reconnect')) return response(200, { sessionId: 's1', status: 'reconnecting' })
      if (target.pathname.endsWith('/sessions/s1') && init?.method === 'DELETE') return response(204)
      return response(404)
    }) as unknown as typeof fetch
    const client = new OpenWAClient({ baseUrl: 'https://openwa.example.com', apiKey: 'key', fetchImpl })

    const created = await client.createSession({ sessionId: 's1', engine: 'baileys', idempotencyKey: 'create-s1' })
    expect(created.status).toBe('waiting_qr')
    expect(created.raw?.qr).toBe('[REDACTED]')
    await expect(client.getSessionQr('s1')).resolves.toEqual({ qr: 'secret-qr', expiresAt: '2026-10-24T00:00:00Z' })
    await expect(client.reconnectSession('s1')).resolves.toMatchObject({ status: 'reconnecting' })
    await expect(client.logoutSession('s1')).resolves.toBeUndefined()
  })

  it('rejects QR responses without QR material', async () => {
    const client = new OpenWAClient({
      baseUrl: 'https://openwa.example.com', apiKey: 'key',
      fetchImpl: vi.fn(async () => response(200, { status: 'waiting_qr' })) as unknown as typeof fetch,
    })
    await expect(client.getSessionQr('s1')).rejects.toMatchObject({ code: 'retryable_provider_failure' })
  })

  it('maps authentication and rate-limit errors', async () => {
    for (const [status, code] of [[401, 'authentication_or_configuration'], [429, 'rate_limited']] as const) {
      const client = new OpenWAClient({
        baseUrl: 'https://openwa.example.com',
        apiKey: 'key',
        fetchImpl: vi.fn(async () => response(status)) as unknown as typeof fetch,
      })
      await expect(client.request('/health')).rejects.toMatchObject({ code })
    }
  })

  it('treats a timeout as an ambiguous outcome', async () => {
    const fetchImpl = vi.fn((...args: Parameters<typeof fetch>) => new Promise<Response>((resolve, reject) => {
      const init = args[1]
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      void resolve
    })) as unknown as typeof fetch
    const client = new OpenWAClient({ baseUrl: 'https://openwa.example.com', apiKey: 'key', timeoutMs: 5, fetchImpl })
    await expect(client.request('/messages', { method: 'POST', body: { text: 'hello' } })).rejects.toMatchObject({ code: 'ambiguous_outcome' })
  })

  it('rejects malformed JSON and missing provider message ids', async () => {
    const malformed = new OpenWAClient({
      baseUrl: 'https://openwa.example.com',
      apiKey: 'key',
      fetchImpl: vi.fn(async () => new Response('{broken', { status: 200 })) as unknown as typeof fetch,
    })
    await expect(malformed.request('/health')).rejects.toMatchObject({ code: 'retryable_provider_failure' })

    const missingId = new OpenWAClient({
      baseUrl: 'https://openwa.example.com',
      apiKey: 'key',
      fetchImpl: vi.fn(async () => response(200, { ok: true })) as unknown as typeof fetch,
    })
    await expect(missingId.sendText({ sessionId: 's1', to: '1', text: 'x' })).rejects.toMatchObject({ code: 'retryable_provider_failure' })
  })

  it('recursively redacts credential and QR shaped fields', () => {
    expect(redactOpenWAValue({ apiKey: 'a', qr: 'c', nested: { webhook_secret: 'b', value: 1 } })).toEqual({
      apiKey: '[REDACTED]', qr: '[REDACTED]',
      nested: { webhook_secret: '[REDACTED]', value: 1 },
    })
  })
})
