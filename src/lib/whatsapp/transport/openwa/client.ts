import { WhatsAppTransportError, type WhatsAppMediaKind } from '../types'

const DEFAULT_TIMEOUT_MS = 10_000
// Session initialization can spawn a browser and create its profile. The
// 10-second control-plane default is too short for this non-repeatable POST.
const SESSION_CREATE_TIMEOUT_MS = 45_000
const MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000
const MEDIA_SEND_TIMEOUT_MS = 75_000
const REDACTED = '[REDACTED]'
export interface OpenWAClientConfig { baseUrl: string; apiKey: string; timeoutMs?: number; allowedHosts?: readonly string[]; fetchImpl?: typeof fetch }
export interface OpenWARequestOptions { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; correlationId?: string; idempotencyKey?: string; timeoutMs?: number; ambiguousOnFailure?: boolean }
export interface OpenWASessionStatus { status: string; sessionId?: string; phoneIdentity?: string; raw?: Record<string, unknown> }
export interface OpenWASessionCreateRequest { name: string; correlationId?: string; idempotencyKey?: string }
export interface OpenWASessionCreateResult extends OpenWASessionStatus { qr?: string }
export interface OpenWAQrResult { qr: string; expiresAt?: string }
export interface OpenWASendTextRequest { sessionId: string; to: string; text: string; replyToProviderMessageId?: string; idempotencyKey?: string }
export interface OpenWASendTextResult { providerMessageId: string; raw?: Record<string, unknown> }
export interface OpenWASendMediaRequest { sessionId: string; to: string; kind: WhatsAppMediaKind; link: string; caption?: string; filename?: string; replyToProviderMessageId?: string; idempotencyKey?: string }
export interface OpenWASendMediaResult { providerMessageId: string; raw?: Record<string, unknown> }
export interface OpenWADownloadMediaResult { buffer: Buffer; contentType: string; contentLength: number | null }
export interface OpenWAReconciliationResult { found: boolean; providerMessageId?: string; status?: string; raw?: Record<string, unknown> }
function isPrivateIpv4(hostname: string): boolean { const parts = hostname.split('.').map(Number); if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false; const [a,b] = parts; return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) }
function isUnsafeHostname(hostname: string): boolean { const host = hostname.toLowerCase().replace(/\.$/, ''); return host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.endsWith('.local') || host.endsWith('.internal') || isPrivateIpv4(host) }
export function validateOpenWABaseUrl(baseUrl: string, allowedHosts: readonly string[] = []): URL { let url: URL; try { url = new URL(baseUrl) } catch { throw new WhatsAppTransportError('invalid_request', 'OpenWA base URL is invalid') }; if (url.protocol !== 'https:') throw new WhatsAppTransportError('invalid_request', 'OpenWA base URL must use HTTPS'); if (url.username || url.password || url.search || url.hash) throw new WhatsAppTransportError('invalid_request', 'OpenWA base URL must not contain credentials, query, or fragment'); const allow = new Set(allowedHosts.map((host) => host.toLowerCase())); if (isUnsafeHostname(url.hostname) && !allow.has(url.hostname.toLowerCase())) throw new WhatsAppTransportError('invalid_request', 'OpenWA base URL targets a restricted host'); url.pathname = url.pathname.replace(/\/+$/, '') || '/'; return url }
export function redactOpenWAValue(value: unknown): unknown { if (Array.isArray(value)) return value.map(redactOpenWAValue); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key,item]) => [key, /token|secret|authorization|api[-_]?key|cookie|qr|signed.?url/i.test(key) ? REDACTED : redactOpenWAValue(item)])) }
function mapHttpError(status: number, safeCode?: string): WhatsAppTransportError { if (status === 400 || status === 404 || status === 422) return new WhatsAppTransportError('invalid_request', `OpenWA request rejected (${status}${safeCode ? `; code=${safeCode}` : ''})`); if (status === 401 || status === 403) return new WhatsAppTransportError('authentication_or_configuration', `OpenWA authentication failed (${status})`); if (status === 409) return new WhatsAppTransportError('connection_restricted', 'OpenWA connection state rejected the request'); if (status === 429) return new WhatsAppTransportError('rate_limited', 'OpenWA rate limit reached'); if (status >= 500) return new WhatsAppTransportError('retryable_provider_failure', `OpenWA provider failure (${status})`); return new WhatsAppTransportError('permanent_provider_failure', `OpenWA request failed (${status})`) }
/** Only expose a whitelisted *shape* of upstream error code. Never forward
 * arbitrary gateway response text, URLs, bearer secrets or HTML to users. */
async function safeOpenWAErrorCode(response: Response): Promise<string | undefined> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('json')) return undefined
  try {
    const value: unknown = await response.json()
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const data = value as Record<string, unknown>
    const nested = data.error && typeof data.error === 'object' && !Array.isArray(data.error)
      ? data.error as Record<string, unknown> : null
    const code = typeof data.code === 'string' ? data.code : nested?.code
    if (typeof code !== 'string' || !/^[a-z][a-z0-9_]{2,48}$/i.test(code)) return undefined
    return code.toUpperCase()
  } catch {
    return undefined
  }
}
/** Classify only known system error *codes* from node/undici, not
 * untrusted exception messages (which can contain private hostnames/URLs).
 * A generic failure remains generic. Nested causes are bounded. */
function safeNetworkFailureKind(error: unknown): 'DNS lookup failed' | 'Connection refused' | 'Connection interrupted' | 'Connection timed out' | 'TLS verification failed' | null {
  let current: unknown = error
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== 'object') break
    const record = current as { code?: unknown; cause?: unknown }
    const code = typeof record.code === 'string' ? record.code : ''
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS lookup failed'
    if (code === 'ECONNREFUSED') return 'Connection refused'
    if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') return 'Connection interrupted'
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') return 'Connection timed out'
    if (['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)) return 'TLS verification failed'
    current = record.cause
  }
  return null
}
function requiredString(payload: Record<string, unknown>, keys: string[], message: string): string { for (const key of keys) { const value = payload[key]; if (typeof value === 'string' && value.trim()) return value } throw new WhatsAppTransportError('retryable_provider_failure', message) }
function gatewayChatId(recipient: string): string {
  const value = recipient.trim().replace(/^\+/, '')
  if (/^\d+$/.test(value)) return `${value}@c.us`
  if (/^[a-zA-Z0-9._:-]+@(c\.us|g\.us|lid)$/.test(value)) return value
  throw new WhatsAppTransportError('invalid_request', 'OpenWA recipient must be a phone number or WhatsApp chat ID')
}
function sessionFromGateway(response: Record<string, unknown>): OpenWASessionStatus {
  return {
    sessionId: typeof response.id === 'string' ? response.id : undefined,
    status: requiredString(response, ['status'], 'OpenWA session status is missing'),
    phoneIdentity: typeof response.phone === 'string' ? response.phone : undefined,
    raw: redactOpenWAValue(response) as Record<string, unknown>,
  }
}
export class OpenWAClient {
  private readonly baseUrl: URL; private readonly timeoutMs: number; private readonly fetchImpl: typeof fetch
  constructor(private readonly config: OpenWAClientConfig) { if (!config.apiKey.trim()) throw new WhatsAppTransportError('authentication_or_configuration', 'OpenWA API key is missing'); this.baseUrl = validateOpenWABaseUrl(config.baseUrl, config.allowedHosts); this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS; this.fetchImpl = config.fetchImpl ?? fetch }
  private target(path: string): URL { if (!path.startsWith('/') || path.startsWith('//')) throw new WhatsAppTransportError('invalid_request', 'OpenWA request path must be absolute and origin-relative'); const target = new URL(path, this.baseUrl); if (target.origin !== this.baseUrl.origin) throw new WhatsAppTransportError('invalid_request', 'OpenWA request escaped the configured origin'); return target }
  async request<T>(path: string, options: OpenWARequestOptions = {}): Promise<T> {
    const target = this.target(path)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs)
    const canHaveSent = options.method === 'POST' && (Boolean(options.idempotencyKey) || options.ambiguousOnFailure === true)
    const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${this.config.apiKey}` }
    if (target.hostname.endsWith('.ngrok-free.app')) headers['ngrok-skip-browser-warning'] = '1'
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (options.correlationId) headers['x-correlation-id'] = options.correlationId
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey
    try {
      const response = await this.fetchImpl(target, {
        method: options.method ?? 'GET', headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal, redirect: 'error',
      })
      if (!response.ok) {
        // Read ONLY the bounded machine-readable error code for diagnostics,
        // never raw gateway errors or URLs that might expose private media.
        const safeCode = await safeOpenWAErrorCode(response)
        // OpenWA may explicitly indicate uncertain outcomes even with a 4xx.
        // A 409/5xx response to a send is always ambiguous, never retried.
        const outcomeUnknown = safeCode === 'IDEMPOTENCY_OUTCOME_UNKNOWN'
          || safeCode === 'SEND_OUTCOME_UNKNOWN'
        if (canHaveSent && (outcomeUnknown || response.status === 409 || response.status >= 500)) {
          throw new WhatsAppTransportError('ambiguous_outcome', 'OpenWA send outcome is uncertain; reconcile before retrying')
        }
        throw mapHttpError(response.status, safeCode)
      }
      if (response.status === 204) return undefined as T
      try { return await response.json() as T }
      catch (error) {
        throw new WhatsAppTransportError(canHaveSent ? 'ambiguous_outcome' : 'retryable_provider_failure', 'OpenWA returned malformed JSON', error)
      }
    } catch (error) {
      if (error instanceof WhatsAppTransportError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new WhatsAppTransportError('ambiguous_outcome', 'OpenWA request timed out; outcome requires reconciliation', error)
      }
      const detail = safeNetworkFailureKind(error)
      const message = `OpenWA network request failed${detail ? ` (${detail})` : ''}${canHaveSent ? '; outcome requires reconciliation' : ''}`
      throw new WhatsAppTransportError(canHaveSent ? 'ambiguous_outcome' : 'retryable_provider_failure', message, error)
    } finally { clearTimeout(timeout) }
  }
  async downloadMedia(sessionId: string, messageId: string, chatId: string, correlationId?: string): Promise<OpenWADownloadMediaResult> {
    if (!chatId || !messageId) throw new WhatsAppTransportError('invalid_request', 'OpenWA media requires the original chat and message IDs')
    const target = this.target(`/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId)}/media`)
    const controller = new AbortController()
    // Media archives (especially video) can take longer than control-plane
    // JSON calls through a tunnel. Keep the limit bounded for webhook workers.
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? MEDIA_DOWNLOAD_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(target, { headers: { accept: '*/*', authorization: `Bearer ${this.config.apiKey}`, ...(correlationId ? { 'x-correlation-id': correlationId } : {}) }, signal: controller.signal, redirect: 'error' })
      if (!response.ok) throw mapHttpError(response.status)
      const lengthHeader = response.headers.get('content-length')
      const length = lengthHeader ? Number(lengthHeader) : NaN
      return { buffer: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') || 'application/octet-stream', contentLength: Number.isFinite(length) && length >= 0 ? length : null }
    } catch (error) {
      if (error instanceof WhatsAppTransportError) throw error
      if (error instanceof Error && error.name === 'AbortError') throw new WhatsAppTransportError('retryable_provider_failure', 'OpenWA media download timed out', error)
      throw new WhatsAppTransportError('retryable_provider_failure', 'OpenWA media download failed', error)
    } finally { clearTimeout(timeout) }
  }
  async reconcileOutbound(_sessionId: string, _idempotencyKey: string): Promise<OpenWAReconciliationResult> {
    // The upstream API exposes no lookup by Idempotency-Key. Never interpret a 404
    // on an invented endpoint as evidence that a send did not happen.
    throw new WhatsAppTransportError('ambiguous_outcome', 'OpenWA send outcome requires operator reconciliation; automatic idempotency lookup is unavailable')
  }
  async createSession(request: OpenWASessionCreateRequest): Promise<OpenWASessionCreateResult> {
    const response = await this.request<Record<string, unknown>>('/api/sessions', {
      method: 'POST', correlationId: request.correlationId,
      // A timeout here is ambiguous: the gateway may have created a session.
      // Do NOT automatically retry. Keep the deterministic name for
      // operator-side reconciliation of this one attempt.
      timeoutMs: this.config.timeoutMs ?? SESSION_CREATE_TIMEOUT_MS,
      ambiguousOnFailure: true,
      body: { name: request.name },
    })
    const session = sessionFromGateway(response)
    if (!session.sessionId) throw new WhatsAppTransportError('ambiguous_outcome', 'OpenWA created a session without a usable session id; manual reconciliation required')
    return session
  }
  async getSessionStatus(sessionId: string, correlationId?: string): Promise<OpenWASessionStatus> {
    const response = await this.request<Record<string, unknown>>(`/api/sessions/${encodeURIComponent(sessionId)}`, { correlationId })
    return sessionFromGateway(response)
  }
  async getSessionQr(sessionId: string, correlationId?: string): Promise<OpenWAQrResult> {
    const response = await this.request<Record<string, unknown>>(`/api/sessions/${encodeURIComponent(sessionId)}/qr`, { correlationId })
    const qr = requiredString(response, ['qrCode'], 'OpenWA QR response is missing image data')
    if (!/^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(qr) || qr.length > 512_000) {
      throw new WhatsAppTransportError('retryable_provider_failure', 'OpenWA QR response has an invalid image format')
    }
    return { qr }
  }
  async configureWebhook(sessionId: string, url: string, secret: string, correlationId?: string): Promise<void> {
    if (!secret || secret.length < 16) throw new WhatsAppTransportError('invalid_request', 'OpenWA webhook signing secret is too short')
    // The webhook URL is deployment-controlled, not supplied by an agent or end user.
    const endpoint = validateOpenWABaseUrl(url)
    if (endpoint.pathname !== '/api/whatsapp/openwa/webhook') {
      throw new WhatsAppTransportError('invalid_request', 'OpenWA webhook URL must target the WACRM OpenWA intake route')
    }
    const prefix = `/api/sessions/${encodeURIComponent(sessionId)}/webhooks`
    const existing = await this.request<Array<{ id: string; url: string }>>(prefix, { correlationId })
    if (!Array.isArray(existing)) throw new WhatsAppTransportError('retryable_provider_failure', 'OpenWA returned an invalid webhook list')
    const matching = existing.find((item) => item.url === url)
    const payload = {
      url, secret, events: ['message.received', 'message.sent', 'message.ack', 'message.failed', 'message.receipt',
        'session.status', 'session.authenticated', 'session.disconnected', 'session.restriction'],
    }
    if (matching) {
      await this.request(`${prefix}/${encodeURIComponent(matching.id)}`, {
        method: 'PUT', correlationId, body: { ...payload, active: true },
      })
    } else {
      await this.request(prefix, { method: 'POST', correlationId, body: payload })
    }
  }
  async startSession(sessionId: string, correlationId?: string): Promise<OpenWASessionStatus> {
    const response = await this.request<Record<string, unknown>>(`/api/sessions/${encodeURIComponent(sessionId)}/start`, { method: 'POST', correlationId, timeoutMs: 45_000, ambiguousOnFailure: true })
    return sessionFromGateway(response)
  }
  reconnectSession(sessionId: string, correlationId?: string): Promise<OpenWASessionStatus> {
    return this.startSession(sessionId, correlationId)
  }
  async logoutSession(sessionId: string, correlationId?: string): Promise<void> {
    await this.request<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/logout`, { method: 'POST', correlationId })
  }
  async sendText(request: OpenWASendTextRequest, correlationId?: string): Promise<OpenWASendTextResult> {
    const response = await this.request<Record<string, unknown>>(`/api/sessions/${encodeURIComponent(request.sessionId)}/messages/send-text`, {
      method: 'POST', correlationId, idempotencyKey: request.idempotencyKey,
      body: { chatId: gatewayChatId(request.to), text: request.text, ...(request.replyToProviderMessageId ? { quotedMessageId: request.replyToProviderMessageId } : {}) },
    })
    const providerMessageId = typeof response.messageId === 'string' ? response.messageId : null
    if (!providerMessageId) throw new WhatsAppTransportError('ambiguous_outcome', 'OpenWA send response is missing a provider message id')
    return { providerMessageId, raw: redactOpenWAValue(response) as Record<string, unknown> }
  }
  async markChatRead(sessionId: string, chatId: string): Promise<void> {
    // Acknowledges WhatsApp-side read state for one validated one-to-one
    // chat. Never derive @c.us from an @lid, and never auto-resend sends.
    if (!/^[0-9]{5,20}@(c\.us|lid)$/.test(chatId)) {
      throw new WhatsAppTransportError('invalid_request', 'OpenWA read receipt requires a verified one-to-one chat ID')
    }
    await this.request<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/chats/read`, {
      method: 'POST', body: { chatId },
    })
  }
  async sendMedia(request: OpenWASendMediaRequest, correlationId?: string): Promise<OpenWASendMediaResult> {
    if (!['image', 'video', 'document', 'audio'].includes(request.kind)) throw new WhatsAppTransportError('unsupported_capability', 'Unsupported OpenWA media kind')
    if (!request.link) throw new WhatsAppTransportError('invalid_request', 'OpenWA media send requires a WACRM media URL')
    if (request.caption && request.kind !== 'audio' && request.caption.length > 1024) throw new WhatsAppTransportError('invalid_request', 'OpenWA media caption exceeds 1024 characters')
    const response = await this.request<Record<string, unknown>>(`/api/sessions/${encodeURIComponent(request.sessionId)}/messages/send-${request.kind}`, {
      method: 'POST', correlationId, idempotencyKey: request.idempotencyKey,
      // Gateway may fetch remote video, generate thumbnails and wait for
      // Chromium media metadata. This control-plane POST is not equivalent
      // to a 10s JSON request. Keep an explicit timeout override for tests.
      timeoutMs: this.config.timeoutMs ?? MEDIA_SEND_TIMEOUT_MS,
      body: {
        chatId: gatewayChatId(request.to), url: request.link,
        ...(request.kind !== 'audio' && request.caption ? { caption: request.caption } : {}),
        ...(request.filename ? { filename: request.filename } : {}),
        ...(request.replyToProviderMessageId ? { quotedMessageId: request.replyToProviderMessageId } : {}),
      },
    })
    const providerMessageId = typeof response.messageId === 'string' ? response.messageId : null
    if (!providerMessageId) throw new WhatsAppTransportError('ambiguous_outcome', 'OpenWA media response is missing a provider message id')
    return { providerMessageId, raw: redactOpenWAValue(response) as Record<string, unknown> }
  }
}
