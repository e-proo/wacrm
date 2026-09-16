// `URL` is a value (constructor), not just a type — import normally.
import { URL } from 'url'
import { aiRequestTimeoutMs } from '../defaults'

// ============================================================
// Outbound URL policy — the single gatekeeper every connection-aware
// network call must pass. Designed to be testable without real DNS:
// inject a resolver (and transport) so tests can assert SSRF guards
// deterministically.
// ============================================================

const ALLOWED_SCHEMES = new Set(['https:'])
const DEFAULT_PORTS: Record<string, number> = {
  https: 443,
  http: 80,
}
const MAX_URL_LENGTH = 2048
/** Maximum response body size enforced by the caller before `json()` (Phase 02+). Kept exported so tests can assert the ceiling. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024 // 2 MB
// Single timeout knob with generate/embed: `AI_REQUEST_TIMEOUT_MS`
// (default 120s for reasoning models). The outbound path used to
// carry its own 30s constant that aborted slow providers mid-run.

// Deployment-level overrides.
const PRIVATE_ENDPOINTS_ENABLED =
  process.env.AI_PRIVATE_ENDPOINTS_ENABLED === 'true'

const ALLOWLIST = process.env.AI_ENDPOINT_ALLOWLIST
  ? new Set(
      process.env.AI_ENDPOINT_ALLOWLIST.split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    )
  : new Set<string>()

/** Injected DNS resolver (default: Node native). */
export type DnsResolver = (hostname: string) => Promise<{ addresses: string[] }>

/** Injected transport factory (default: global fetch). */
export type TransportFactory = (
  input: string | URL,
  init: Record<string, unknown>,
) => Promise<Response>

export interface UrlPolicyOptions {
  resolver?: DnsResolver
  transport?: TransportFactory
  allowPrivate?: boolean
}

/** Result of a DNS resolution + classification pass. */
export interface ResolvedTarget {
  host: string
  port: number
  ips: string[]
  allowed: boolean
  reason: string
}

// ------------------------------------------------------------
// IP classification (private / loopback / metadata, etc.)
// Uses RFC-standard ranges only — no third-party dependency.
// ------------------------------------------------------------

function parseIPv4(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const n = parts.map(Number)
  if (n.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return null
  return (n[0] << 24) >>> 0 | (n[1] << 16) | (n[2] << 8) | n[3]
}

/** True when the IPv4 falls in any blocked range. Exported for tests. */
export function isBlockedIPv4(ip: string): boolean {
  const n = parseIPv4(ip)
  if (n === null) return true // malformed → block conservatively
  const inNet = (base: number, mask: number): boolean =>
    (n & mask) >>> 0 === (base & mask) >>> 0

  // 0.0.0.0/8, 127.0.0.0/8, 10.0.0.0/8
  if (inNet(0x00000000, 0xff000000)) return true
  if (inNet(0x7f000000, 0xff000000)) return true
  if (inNet(0x0a000000, 0xff000000)) return true
   // 172.16.0.0/12
   if (inNet(0xac100000, 0xfffff000)) return true
  // 192.168.0.0/16
  if (inNet(0xc0a80000, 0xffff0000)) return true
  // 100.64.0.0/10 CGNAT
  if (inNet(0x64400000, 0xffc00000)) return true
  // 169.254.0.0/16 link-local
  if (inNet(0xa9fe0000, 0xffff0000)) return true
  // 224.0.0.0/4 multicast
  if (inNet(0xe0000000, 0xf0000000)) return true
  // 240.0.0.0/4 reserved
  if (inNet(0xf0000000, 0xf0000000)) return true
  // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (documentation/test nets)
  if (inNet(0xc0000200, 0xffffff00)) return true
  if (inNet(0xc6336400, 0xffffff00)) return true
  if (inNet(0xcb007100, 0xffffff00)) return true
  return false
}

/** Minimal IPv6 private/loopback/metadata classifier. Exported for tests. */
export function isBlockedIPv6(ip: string): boolean {
  const lowered = ip.toLowerCase()
  if (lowered === '::1' || lowered === '::') return true
  if (lowered.startsWith('fe8')) return true // fe80::/10 link-local
  if (lowered.startsWith('fc') || lowered.startsWith('fd')) return true // fc00::/7
  if (lowered.startsWith('ff')) return true // ff00::/8 multicast
  // IPv4-mapped IPv6 ::ffff:a.b.c.d — classify the embedded v4.
  if (lowered.startsWith('::ffff:')) {
    return isBlockedIPv4(lowered.replace('::ffff:', ''))
  }
  return false
}

function classifyIp(ip: string): boolean {
  return ip.includes(':') ? isBlockedIPv6(ip) : isBlockedIPv4(ip)
}

/** True for IPv4/IPv6 literal hosts (no DNS involved). */
export function isIpLiteral(host: string): boolean {
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true
  return h.includes(':') // any colon-bearing host is an IPv6 literal in URL position
}

/** Shared IP blocker (also used for literal hosts below and by tests). */
export { classifyIp }

// ------------------------------------------------------------
// URL parsing + validation
// ------------------------------------------------------------

export interface UrlValidationResult {
  url: URL | null
  error: string | null
  /** Non-null when the destination must be blocked. */
  blockedReason: string | null
}

export function validateUrl(
  raw: string,
  opts: { allowPrivate?: boolean } = {},
): UrlValidationResult {
  if (raw.length > MAX_URL_LENGTH) {
    return { url: null, error: 'URL too long', blockedReason: 'url_too_long' }
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { url: null, error: 'Invalid URL', blockedReason: null }
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return { url, error: `Scheme '${url.protocol}' is not allowed`, blockedReason: 'scheme_not_allowed' }
  }

  // No username:password, no fragment.
  if (url.username || url.password) {
    return { url, error: 'Credentials in URL not allowed', blockedReason: 'credentials_in_url' }
  }
  if (url.hash) {
    return { url, error: 'Fragment not allowed', blockedReason: 'fragment_not_allowed' }
  }

  const host = url.hostname.toLowerCase()
  if (!host || host.length > 253) {
    return { url, error: 'Invalid host', blockedReason: 'invalid_host' }
  }

  // localhost variants
  if ((host === 'localhost' || host.endsWith('.localhost')) && !opts.allowPrivate) {
    return { url, error: 'localhost blocked', blockedReason: 'localhost_blocked' }
  }

  // Port validation: only 443 by default; non-standard ports need deployment allowlist.
  const port = url.port ? Number(url.port) : (DEFAULT_PORTS[url.protocol] ?? 443)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { url, error: `Invalid port ${port}`, blockedReason: 'invalid_port' }
  }
  if (port !== 443 && !ALLOWLIST.has(`${host}:${port}`)) {
    return { url, error: `Port ${port} not on allowlist`, blockedReason: 'port_not_allowed' }
  }

  // Deployment allowlist for custom/private hosts.
  if (
    ALLOWLIST.size > 0 &&
    !ALLOWLIST.has(host) &&
    !ALLOWLIST.has(`${host}:${port}`) &&
    !opts.allowPrivate
  ) {
    return { url, error: 'Host not on allowlist', blockedReason: 'host_not_allowed' }
  }

  return { url, error: null, blockedReason: null }
}

// ------------------------------------------------------------
// DNS resolution + target classification
// ------------------------------------------------------------

export async function resolveTarget(
  url: URL,
  opts: { resolver?: DnsResolver; allowPrivate?: boolean } = {},
): Promise<ResolvedTarget> {
  const resolver = opts.resolver ?? defaultResolver
  const host = url.hostname
  const port = url.port ? Number(url.port) : (DEFAULT_PORTS[url.protocol] ?? 443)

  // IP-literal hosts bypass DNS entirely — classify the literal. Without
  // this, `https://169.254.169.254/...` would slip past a resolver that
  // returns no answers for raw IPs.
  if (isIpLiteral(host)) {
    const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
    if (classifyIp(literal) && !opts.allowPrivate) {
      return { host, port, ips: [], allowed: false, reason: `Literal address is blocked (${literal})` }
    }
    return { host, port, ips: [literal], allowed: true, reason: '' }
  }

  const { addresses } = await resolver(host)
  const blocked = addresses.filter(classifyIp)
  if (blocked.length > 0 && !opts.allowPrivate) {
    return {
      host,
      port,
      ips: [],
      allowed: false,
      reason: `Resolved to a blocked address (${blocked[0]})`,
    }
  }
  // A domain we cannot resolve to ANY address is refused, not allowed:
  // silently passing would defeat the point of classifying.
  if (addresses.length === 0) {
    return { host, port, ips: [], allowed: false, reason: 'Hostname did not resolve to any address' }
  }

  return {
    host,
    port,
    ips: addresses,
    allowed: true,
    reason: '',
  }
}

async function defaultResolver(hostname: string): Promise<{ addresses: string[] }> {
  const dns = await import('dns').then((m) => m.promises)
  const [a, aaaa] = await Promise.allSettled([
    dns.resolve4(hostname).catch(() => []),
    dns.resolve6(hostname).catch(() => []),
  ])
  const v4 = a.status === 'fulfilled' ? (a.value as string[]) : []
  const v6 = aaaa.status === 'fulfilled' ? (aaaa.value as string[]) : []
  const direct = [...new Set([...v4, ...v6])]
  if (direct.length > 0) return { addresses: direct }

  // On Windows/VPN setups a long-lived Node/c-ares resolver can temporarily
  // disagree with the resolver used by the OS socket stack. `fetch` ultimately
  // connects through that OS path, so when resolve4/resolve6 both return no
  // answers, query the system resolver as a fallback. Every returned address
  // still goes through the exact same private/loopback/metadata classification
  // in resolveTarget; this improves availability without weakening SSRF policy.
  try {
    const lookedUp = await dns.lookup(hostname, { all: true })
    return { addresses: [...new Set(lookedUp.map((entry) => entry.address))] }
  } catch {
    return { addresses: [] }
  }
}

// ------------------------------------------------------------
// Outbound transport
// ------------------------------------------------------------

export interface SendResult {
  response: Response | null
  bytesReceived: number
  timedOut: boolean
}

export interface SendOptions {
  input: URL
  init: Record<string, unknown>
  opts?: UrlPolicyOptions
}

/**
 * Send a request only after the policy passes. The transport is
 * injected so tests can stub it. `redirect: manual` is forced to
 * prevent automatic following of redirects.
 */
export async function sendOutbound(opts: SendOptions): Promise<SendResult> {
  const { input, init, opts: urlOpts } = opts
  const allowPrivate = urlOpts?.allowPrivate ?? PRIVATE_ENDPOINTS_ENABLED

  const validation = validateUrl(input.toString(), { allowPrivate })
  if (validation.blockedReason) {
    throw new OutboundBlockedError(validation.error ?? 'Blocked')
  }

  const target = await resolveTarget(input, {
    resolver: urlOpts?.resolver,
    allowPrivate,
  })
  if (!target.allowed) {
    throw new OutboundBlockedError(target.reason)
  }

  const transport = urlOpts?.transport ?? ((input: string | URL, init: Record<string, unknown>) => (globalThis as { fetch: typeof fetch }).fetch(input, init))
  const timeoutMs = aiRequestTimeoutMs()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await transport(input, {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
    })
    return { response, bytesReceived: 0, timedOut: false }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { response: null, bytesReceived: 0, timedOut: true }
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export class OutboundBlockedError extends Error {
  readonly code = 'AI_CONNECTION_BLOCKED'
  constructor(message: string) {
    super(message)
    this.name = 'OutboundBlockedError'
  }
}
