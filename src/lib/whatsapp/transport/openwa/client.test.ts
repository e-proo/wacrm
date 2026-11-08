import { describe, expect, it, vi } from 'vitest'
import { OpenWAClient, redactOpenWAValue, validateOpenWABaseUrl } from './client'
import { WhatsAppTransportError } from '../types'

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })
}

describe('OpenWA upstream REST contract', () => {
  it('requires HTTPS and rejects private hosts unless expressly allowlisted', () => {
    expect(() => validateOpenWABaseUrl('http://openwa.example.com')).toThrow(WhatsAppTransportError)
    expect(() => validateOpenWABaseUrl('https://127.0.0.1:2785')).toThrow(WhatsAppTransportError)
    expect(() => validateOpenWABaseUrl('https://192.168.1.10')).toThrow(WhatsAppTransportError)
    expect(validateOpenWABaseUrl('https://10.0.0.5:8443', ['10.0.0.5']).origin).toBe('https://10.0.0.5:8443')
    expect(validateOpenWABaseUrl('https://example.ngrok-free.app').origin).toBe('https://example.ngrok-free.app')
  })

  it('uses actual /api/sessions send-text contract with auth, quotedMessageId and idempotency', async () => {
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      expect((args[0] as URL).pathname).toBe('/api/sessions/s1/messages/send-text')
      const headers = args[1]?.headers as Record<string, string>
      expect(headers.authorization).toBe('Bearer secret-key')
      expect(headers['x-correlation-id']).toBe('corr-1')
      expect(headers['idempotency-key']).toBe('idem-1')
      expect(JSON.parse(String(args[1]?.body))).toEqual({ chatId: '967700000000@c.us', text: 'hello', quotedMessageId: 'quoted-1' })
      return response(201, { messageId: 'msg-1', token: 'must-not-leak' })
    }) as unknown as typeof fetch
    const client = new OpenWAClient({ baseUrl: 'https://openwa.example.com', apiKey: 'secret-key', fetchImpl })
    const result = await client.sendText({ sessionId: 's1', to: '967700000000', text: 'hello', replyToProviderMessageId: 'quoted-1', idempotencyKey: 'idem-1' }, 'corr-1')
    expect(result.providerMessageId).toBe('msg-1')
    expect(result.raw?.token).toBe('[REDACTED]')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('sends a verified LID unchanged, never fabricating a phone JID', async () => {
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      expect(JSON.parse(String(args[1]?.body))).toEqual({ chatId: '63256345444412@lid', text: 'safe reply' })
      return response(201, { messageId: 'lid-reply-1' })
    }) as unknown as typeof fetch
    const client = new OpenWAClient({ baseUrl: 'https://openwa.example.com', apiKey: 'key', fetchImpl })
    expect((await client.sendText({ sessionId: 's', to: '63256345444412@lid', text: 'safe reply', idempotencyKey: 'lid-1' })).providerMessageId).toBe('lid-reply-1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('uses the kind-specific media route and flat upstream DTO', async () => {
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      expect((args[0] as URL).pathname).toBe('/api/sessions/s1/messages/send-document')
      expect((args[1]?.headers as Record<string,string>)['idempotency-key']).toBe('media-1')
      expect(JSON.parse(String(args[1]?.body))).toEqual({
        chatId: '967700000000@c.us',
        url: 'https://storage.example/invoice.pdf',
        caption: 'invoice', filename: 'invoice.pdf', quotedMessageId: 'reply-1',
      })
      return response(201, { messageId: 'ow-media-1', signedUrl: 'hidden' })
    }) as unknown as typeof fetch
    const client = new OpenWAClient({ baseUrl: 'https://openwa.example.com', apiKey: 'key', fetchImpl })
    const result = await client.sendMedia({
      sessionId: 's1', to: '967700000000', kind: 'document',
      link: 'https://storage.example/invoice.pdf', caption: 'invoice', filename: 'invoice.pdf',
      replyToProviderMessageId: 'reply-1', idempotencyKey: 'media-1',
    }, 'media-1')
    expect(result.providerMessageId).toBe('ow-media-1')
    expect(result.raw?.signedUrl).toBe('[REDACTED]')
  })

  it('downloads the original scoped message media by chat and message ID', async () => {
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      expect((args[0] as URL).pathname).toBe('/api/sessions/s1/messages/123%40c.us/m-1/media')
      expect((args[1]?.headers as Record<string,string>).authorization).toBe('Bearer key')
      return new Response(new Uint8Array([1,2,3]), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '3' } })
    }) as unknown as typeof fetch
    const client = new OpenWAClient({ baseUrl: 'https://openwa.example.com', apiKey: 'key', fetchImpl })
    const result = await client.downloadMedia('s1','m-1','123@c.us')
    expect(result.contentLength).toBe(3)
  })

  it('allows a 15-second archive download without the 10-second JSON timeout aborting it', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => new Promise<Response>((resolve, reject) => {
        args[1]?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        setTimeout(() => resolve(new Response(new Uint8Array([1, 2, 3]), {
          status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '3' },
        })), 15_000)
      })) as unknown as typeof fetch
      const client = new OpenWAClient({ baseUrl: 'https://openwa.example.com', apiKey: 'key', fetchImpl })
      const pending = client.downloadMedia('session', 'video-msg', '123@c.us')
      await vi.advanceTimersByTimeAsync(15_000)
      expect((await pending).contentType).toBe('video/mp4')
    } finally {
      vi.useRealTimers()
    }
  })

  it('subscribes to the own-device message.sent echo', async () => {
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (args[1]?.method === 'GET') return response(200, [])
      return response(201, { id: 'hook-1' })
    }) as unknown as typeof fetch
    const client = new OpenWAClient({ baseUrl: 'https://openwa.example.com', apiKey: 'key', fetchImpl })
    await client.configureWebhook('s', 'https://wacrm.example.com/api/whatsapp/openwa/webhook', '1234567890123456')
    const post = fetchImpl.mock.calls.find((args) => args[1]?.method === 'POST')
    expect(JSON.parse(String(post?.[1]?.body)).events).toContain('message.sent')
  })

  it('marks only a validated 1:1 chat as read via the OpenWA API', async () => {
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      expect((args[0] as URL).pathname).toBe('/api/sessions/s/chats/read')
      expect(args[1]?.method).toBe('POST')
      expect(JSON.parse(String(args[1]?.body))).toEqual({ chatId: '12345678901@lid' })
      return response(200, { success: true })
    }) as unknown as typeof fetch
    const client = new OpenWAClient({ baseUrl: 'https://openwa.example.com', apiKey: 'key', fetchImpl })
    await client.markChatRead('s', '12345678901@lid')
    await expect(client.markChatRead('s', '12345678901@g.us')).rejects.toMatchObject({ code: 'invalid_request' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('permits an OpenWA media send longer than 10s without losing its successful identity', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => new Promise<Response>((resolve, reject) => {
        args[1]?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
        setTimeout(() => resolve(response(201, { messageId: 'native-video-1' })), 15_000)
      })) as unknown as typeof fetch
      const client = new OpenWAClient({ baseUrl: 'https://openwa.example.com', apiKey: 'key', fetchImpl })
      const pending = client.sendMedia({ sessionId: 's', to: '12345678901', kind: 'video', link: 'https://storage.example/v.mp4', idempotencyKey: 'video-key' })
      await vi.advanceTimersByTimeAsync(15_000)
      expect((await pending).providerMessageId).toBe('native-video-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('never invents an idempotency lookup or resends after an ambiguous send', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const client = new OpenWAClient({ baseUrl: 'https://openwa.example.com', apiKey: 'key', fetchImpl })
    await expect(client.reconcileOutbound('s1','send-1')).rejects.toMatchObject({ code: 'ambiguous_outcome' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('creates named sessions, starts them, fetches real PNG QR and logs out on actual routes', async () => {
    const png = 'data:image/png;base64,aGVsbG8='
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const path = (args[0] as URL).pathname
      if (path === '/api/sessions' && args[1]?.method === 'POST') {
        expect(JSON.parse(String(args[1]?.body))).toEqual({ name: 'wacrm-test-session' })
        return response(201, { id: 's1', name: 'wacrm-test-session', status: 'created' })
      }
      if (path === '/api/sessions/s1/start') return response(200, { id: 's1', status: 'initializing' })
      if (path === '/api/sessions/s1') return response(200, { id: 's1', status: 'ready', phone: '967700000000' })
      if (path === '/api/sessions/s1/qr') return response(200, { qrCode: png, status: 'qr_ready' })
      if (path === '/api/sessions/s1/logout') {
        expect(args[1]?.method).toBe('POST')
        return response(200, { message: 'logged out' })
      }
      return response(404)
    }) as unknown as typeof fetch
    const client = new OpenWAClient({ baseUrl: 'https://openwa.example.com', apiKey: 'key', fetchImpl })
    expect(await client.createSession({ name: 'wacrm-test-session' })).toMatchObject({ sessionId: 's1', status: 'created' })
    expect(await client.startSession('s1')).toMatchObject({ status: 'initializing' })
    expect(await client.getSessionStatus('s1')).toMatchObject({ status: 'ready', phoneIdentity: '967700000000' })
    await expect(client.getSessionQr('s1')).resolves.toEqual({ qr: png })
    expect(await client.reconnectSession('s1')).toMatchObject({ status: 'initializing' })
    await expect(client.logoutSession('s1')).resolves.toBeUndefined()
  })

  it('rejects invalid/missing QR material and missing session identity', async () => {
    const qrClient = new OpenWAClient({ baseUrl: 'https://openwa.example.com', apiKey: 'key', fetchImpl: vi.fn(async () => response(200, { qr: 'text-only' })) as unknown as typeof fetch })
    await expect(qrClient.getSessionQr('s1')).rejects.toMatchObject({ code: 'retryable_provider_failure' })
    const idClient = new OpenWAClient({ baseUrl: 'https://openwa.example.com', apiKey: 'key', fetchImpl: vi.fn(async () => response(201, { status: 'created' })) as unknown as typeof fetch })
    await expect(idClient.createSession({ name: 'abc' })).rejects.toMatchObject({ code: 'ambiguous_outcome' })
  })

  it('maps authentication and rate limit failures', async () => {
    for (const [status, code] of [[401,'authentication_or_configuration'],[429,'rate_limited']] as const) {
      const client = new OpenWAClient({ baseUrl: 'https://openwa.example.com', apiKey: 'key', fetchImpl: vi.fn(async () => response(status)) as unknown as typeof fetch })
      await expect(client.request('/api/health')).rejects.toMatchObject({ code })
    }
  })

  it('keeps timeouts ambiguous for send but retryable for media download', async () => {
    const fetchImpl = vi.fn((...args: Parameters<typeof fetch>) => new Promise<Response>((_resolve,reject) => {
      args[1]?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })) as unknown as typeof fetch
    const client = new OpenWAClient({ baseUrl: 'https://openwa.example.com', apiKey: 'key', timeoutMs: 5, fetchImpl })
    await expect(client.sendMedia({ sessionId: 's1', to: '123', kind: 'image', link: 'https://storage.example/a.jpg', idempotencyKey: 'k' })).rejects.toMatchObject({ code: 'ambiguous_outcome' })
    await expect(client.downloadMedia('s1','m1','123@c.us')).rejects.toMatchObject({ code: 'retryable_provider_failure' })
  })

  it('rejects malformed JSON, invalid recipients and missing provider message IDs', async () => {
    const malformed = new OpenWAClient({ baseUrl: 'https://openwa.example.com', apiKey: 'key', fetchImpl: vi.fn(async () => new Response('{broken', { status: 200 })) as unknown as typeof fetch })
    await expect(malformed.request('/api/health')).rejects.toMatchObject({ code: 'retryable_provider_failure' })
    const missingId = new OpenWAClient({ baseUrl: 'https://openwa.example.com', apiKey: 'key', fetchImpl: vi.fn(async () => response(201, { ok: true })) as unknown as typeof fetch })
    await expect(missingId.sendText({ sessionId: 's1', to: '123', text: 'x' })).rejects.toMatchObject({ code: 'ambiguous_outcome' })
    await expect(missingId.sendText({ sessionId: 's1', to: 'bad@@', text: 'x' })).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('treats 409 and 5xx send responses as ambiguous rather than retryable', async () => {
    for (const status of [409, 500, 503]) {
      const client = new OpenWAClient({
        baseUrl: 'https://openwa.example.com', apiKey: 'key',
        fetchImpl: vi.fn(async () => response(status, { code: 'IDEMPOTENCY_OUTCOME_UNKNOWN' })) as unknown as typeof fetch,
      })
      await expect(client.sendText({ sessionId: 's1', to: '123', text: 'hi', idempotencyKey: 'stable-key' }))
        .rejects.toMatchObject({ code: 'ambiguous_outcome' })
    }
  })

  it('registers or updates one signed webhook using upstream endpoints', async () => {
    const calls: Array<{ path: string; method?: string; body?: Record<string, unknown> }> = []
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const path = (args[0] as URL).pathname
      const method = args[1]?.method
      const body = args[1]?.body ? JSON.parse(String(args[1]?.body)) : undefined
      calls.push({ path, method, body })
      if (method === 'GET') return response(200, [{ id: 'hook-1', url: 'https://wacrm.example.com/api/whatsapp/openwa/webhook' }])
      return response(200, { id: 'hook-1' })
    }) as unknown as typeof fetch
    const client = new OpenWAClient({ baseUrl: 'https://openwa.example.com', apiKey: 'key', fetchImpl })
    await client.configureWebhook('s1', 'https://wacrm.example.com/api/whatsapp/openwa/webhook', '1234567890123456')
    expect(calls[0].path).toBe('/api/sessions/s1/webhooks')
    expect(calls[1].path).toBe('/api/sessions/s1/webhooks/hook-1')
    expect(calls[1].method).toBe('PUT')
    expect(calls[1].body).toMatchObject({ secret: '1234567890123456', active: true })
    await expect(client.configureWebhook('s1', 'https://other.example.com/unsafe', '1234567890123456'))
      .rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('recursively redacts secrets and QR material', () => {
    expect(redactOpenWAValue({ apiKey: 'a', qr: 'c', signedUrl: 'd', nested: { webhook_secret: 'b', value: 1 } })).toEqual({
      apiKey: '[REDACTED]', qr: '[REDACTED]', signedUrl: '[REDACTED]', nested: { webhook_secret: '[REDACTED]', value: 1 },
    })
  })
})
