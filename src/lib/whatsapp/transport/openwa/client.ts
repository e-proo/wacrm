import { WhatsAppTransportError, type WhatsAppMediaKind } from '../types'

const DEFAULT_TIMEOUT_MS = 10_000
const REDACTED = '[REDACTED]'

export interface OpenWAClientConfig { baseUrl: string; apiKey: string; timeoutMs?: number; allowedHosts?: readonly string[]; fetchImpl?: typeof fetch }
export interface OpenWARequestOptions { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; correlationId?: string; idempotencyKey?: string }
export interface OpenWASessionStatus { status: string; sessionId?: string; phoneIdentity?: string; raw?: Record<string, unknown> }
export interface OpenWASessionCreateRequest { sessionId: string; engine?: 'whatsapp-web.js' | 'baileys'; correlationId?: string; idempotencyKey?: string }
export interface OpenWASessionCreateResult extends OpenWASessionStatus { qr?: string }
export interface OpenWAQrResult { qr: string; expiresAt?: string }
export interface OpenWASendTextRequest { sessionId: string; to: string; text: string; replyToProviderMessageId?: string; idempotencyKey?: string }
export interface OpenWASendTextResult { providerMessageId: string; raw?: Record<string, unknown> }
export interface OpenWASendMediaRequest { sessionId: string; to: string; kind: WhatsAppMediaKind; link: string; caption?: string; filename?: string; replyToProviderMessageId?: string; idempotencyKey?: string }
export interface OpenWASendMediaResult { providerMessageId: string; raw?: Record<string, unknown> }
export interface OpenWADownloadMediaResult { buffer: Buffer; contentType: string; contentLength: number | null }

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}
function isUnsafeHostname(hostname: string): boolean { const host = hostname.toLowerCase().replace(/\.$/, ''); return host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.endsWith('.local') || host.endsWith('.internal') || isPrivateIpv4(host) }
export function validateOpenWABaseUrl(baseUrl: string, allowedHosts: readonly string[] = []): URL {
  let url: URL
  try { url = new URL(baseUrl) } catch { throw new WhatsAppTransportError('invalid_request', 'OpenWA base URL is invalid') }
  if (url.protocol !== 'https:') throw new WhatsAppTransportError('invalid_request', 'OpenWA base URL must use HTTPS')
  if (url.username || url.password || url.search || url.hash) throw new WhatsAppTransportError('invalid_request', 'OpenWA base URL must not contain credentials, query, or fragment')
  const allow = new Set(allowedHosts.map((host) => host.toLowerCase()))
  if (isUnsafeHostname(url.hostname) && !allow.has(url.hostname.toLowerCase())) throw new WhatsAppTransportError('invalid_request', 'OpenWA base URL targets a restricted host')
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url
}
export function redactOpenWAValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactOpenWAValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [/token|secret|authorization|api[-_]?key|cookie|qr|signed.?url/i.test(key) ? key : key, /token|secret|authorization|api[-_]?key|cookie|qr|signed.?url/i.test(key) ? REDACTED : redactOpenWAValue(item)]))
}
function mapHttpError(status: number): WhatsAppTransportError {
  if (status === 400 || status === 404 || status === 422) return new WhatsAppTransportError('invalid_request', `OpenWA request rejected (${status})`)
  if (status === 401 || status === 403) return new WhatsAppTransportError('authentication_or_configuration', `OpenWA authentication failed (${status})`)
  if (status === 409) return new WhatsAppTransportError('connection_restricted', 'OpenWA connection state rejected the request')
  if (status === 429) return new WhatsAppTransportError('rate_limited', 'OpenWA rate limit reached')
  if (status >= 500) return new WhatsAppTransportError('retryable_provider_failure', `OpenWA provider failure (${status})`)
  return new WhatsAppTransportError('permanent_provider_failure', `OpenWA request failed (${status})`)
}
function requiredString(payload: Record<string, unknown>, keys: string[], message: string): string { for (const key of keys) { const value = payload[key]; if (typeof value === 'string' && value.trim()) return value } throw new WhatsAppTransportError('retryable_provider_failure', message) }

export class OpenWAClient {
  private readonly baseUrl: URL
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  constructor(private readonly config: OpenWAClientConfig) {
    if (!config.apiKey.trim()) throw new WhatsAppTransportError('authentication_or_configuration', 'OpenWA API key is missing')
    this.baseUrl = validateOpenWABaseUrl(config.baseUrl, config.allowedHosts); this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS; this.fetchImpl = config.fetchImpl ?? fetch
  }
  private target(path: string): URL {
    if (!path.startsWith('/') || path.startsWith('//')) throw new WhatsAppTransportError('invalid_request', 'OpenWA request path must be absolute and origin-relative')
    const target = new URL(path, this.baseUrl)
    if (target.origin !== this.baseUrl.origin) throw new WhatsAppTransportError('invalid_request', 'OpenWA request escaped the configured origin')
    return target
  }
  async request<T>(path: string, options: OpenWARequestOptions = {}): Promise<T> {
    const target = this.target(path); const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${this.config.apiKey}` }
    if (options.body !== undefined) headers['content-type'] = 'application/json'; if (options.correlationId) headers['x-correlation-id'] = options.correlationId; if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey
    try {
      const response = await this.fetchImpl(target, { method: options.method ?? 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: controller.signal, redirect: 'error' })
      if (!response.ok) throw mapHttpError(response.status); if (response.status === 204) return undefined as T
      try { return (await response.json()) as T } catch (error) { throw new WhatsAppTransportError('retryable_provider_failure', 'OpenWA returned malformed JSON', error) }
    } catch (error) {
      if (error instanceof WhatsAppTransportError) throw error
      if (error instanceof Error && error.name === 'AbortError') throw new WhatsAppTransportError('ambiguous_outcome', 'OpenWA request timed out; outcome requires reconciliation', error)
      throw new WhatsAppTransportError('retryable_provider_failure', 'OpenWA network request failed', error)
    } finally { clearTimeout(timeout) }
  }
  async downloadMedia(sessionId: string, mediaId: string, correlationId?: string): Promise<OpenWADownloadMediaResult> {
    const target = this.target(`/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(mediaId)}`)
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(target, { headers: { accept: '*/*', authorization: `Bearer ${this.config.apiKey}`, ...(correlationId ? { 'x-correlation-id': correlationId } : {}) }, signal: controller.signal, redirect: 'error' })
      if (!response.ok) throw mapHttpError(response.status)
      const lengthHeader = response.headers.get('content-length'); const length = lengthHeader ? Number(lengthHeader) : NaN
      return { buffer: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') || 'application/octet-stream', contentLength: Number.isFinite(length) && length >= 0 ? length : null }
    } catch (error) {
      if (error instanceof WhatsAppTransportError) throw error
      if (error instanceof Error && error.name === 'AbortError') throw new WhatsAppTransportError('retryable_provider_failure', 'OpenWA media download timed out', error)
      throw new WhatsAppTransportError('retryable_provider_failure', 'OpenWA media download failed', error)
    } finally { clearTimeout(timeout) }
  }
  async createSession(request: OpenWASessionCreateRequest): Promise<OpenWASessionCreateResult> { const response = await this.request<Record<string, unknown>>('/sessions', { method: 'POST', correlationId: request.correlationId, idempotencyKey: request.idempotencyKey, body: { sessionId: request.sessionId, engine: request.engine } }); return { sessionId: typeof response.sessionId === 'string' ? response.sessionId : request.sessionId, status: typeof response.status === 'string' ? response.status : 'creating', phoneIdentity: typeof response.phoneIdentity === 'string' ? response.phoneIdentity : undefined, qr: typeof response.qr === 'string' ? response.qr : undefined, raw: redactOpenWAValue(response) as Record<string, unknown> } }
  getSessionStatus(sessionId: string, correlationId?: string): Promise<OpenWASessionStatus> { return this.request(`/sessions/${encodeURIComponent(sessionId)}`, { correlationId }) }
  async getSessionQr(sessionId: string, correlationId?: string): Promise<OpenWAQrResult> { const response = await this.request<Record<string, unknown>>(`/sessions/${encodeURIComponent(sessionId)}/qr`, { correlationId }); return { qr: requiredString(response, ['qr', 'data', 'code'], 'OpenWA QR response is missing QR material'), expiresAt: typeof response.expiresAt === 'string' ? response.expiresAt : undefined } }
  reconnectSession(sessionId: string, correlationId?: string): Promise<OpenWASessionStatus> { return this.request(`/sessions/${encodeURIComponent(sessionId)}/reconnect`, { method: 'POST', correlationId }) }
  logoutSession(sessionId: string, correlationId?: string): Promise<void> { return this.request(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', correlationId }) }
  async sendText(request: OpenWASendTextRequest, correlationId?: string): Promise<OpenWASendTextResult> {
    const response = await this.request<Record<string, unknown>>(`/sessions/${encodeURIComponent(request.sessionId)}/messages/text`, { method: 'POST', correlationId, idempotencyKey: request.idempotencyKey, body: { to: request.to, text: request.text, replyToProviderMessageId: request.replyToProviderMessageId } })
    const providerMessageId = typeof response.id === 'string' ? response.id : typeof response.messageId === 'string' ? response.messageId : null
    if (!providerMessageId) throw new WhatsAppTransportError('retryable_provider_failure', 'OpenWA send response is missing a provider message id')
    return { providerMessageId, raw: redactOpenWAValue(response) as Record<string, unknown> }
  }
  async sendMedia(request: OpenWASendMediaRequest, correlationId?: string): Promise<OpenWASendMediaResult> {
    if (!['image', 'video', 'document', 'audio'].includes(request.kind)) throw new WhatsAppTransportError('unsupported_capability', 'Unsupported OpenWA media kind')
    if (!request.link) throw new WhatsAppTransportError('invalid_request', 'OpenWA media send requires a WACRM media URL')
    if (request.caption && request.kind !== 'audio' && request.caption.length > 1024) throw new WhatsAppTransportError('invalid_request', 'OpenWA media caption exceeds 1024 characters')
    const response = await this.request<Record<string, unknown>>(`/sessions/${encodeURIComponent(request.sessionId)}/messages/media`, { method: 'POST', correlationId, idempotencyKey: request.idempotencyKey, body: { to: request.to, kind: request.kind, link: request.link, ...(request.kind !== 'audio' && request.caption ? { caption: request.caption } : {}), ...(request.kind === 'document' && request.filename ? { filename: request.filename } : {}), replyToProviderMessageId: request.replyToProviderMessageId } })
    const providerMessageId = typeof response.id === 'string' ? response.id : typeof response.messageId === 'string' ? response.messageId : null
    if (!providerMessageId) throw new WhatsAppTransportError('retryable_provider_failure', 'OpenWA media send response is missing a provider message id')
    return { providerMessageId, raw: redactOpenWAValue(response) as Record<string, unknown> }
  }
}
