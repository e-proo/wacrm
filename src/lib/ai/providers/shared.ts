import { AiError, type AiUsage, type ChatMessage } from '../types'
import { validateUrl, resolveTarget } from '../outbound/url-policy'
import type { AdapterContext } from './contract'

// ============================================================
// Bits shared by the protocol adapters.
// ============================================================

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'max'
type ReasoningCapabilityState = 'supported' | 'unsupported'

/**
 * Runtime-only capability memory. The key contains no secret material: only
 * endpoint origin + model id. A process restart simply returns the capability
 * to unknown and lets negotiation happen again.
 */
const reasoningCapabilityCache = new Map<string, ReasoningCapabilityState>()

function configuredReasoningEffort(): ReasoningEffort | null {
  const raw = (process.env.AI_REASONING_EFFORT ?? 'auto').trim().toLowerCase()
  if (raw === '' || raw === 'auto') return 'low'
  if (raw === 'off' || raw === 'disabled') return null
  if (raw === 'none' || raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'max') {
    return raw
  }
  // Fail safe for a malformed deployment setting: omit the optional field.
  return null
}

function maybeAddReasoningEffort(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
): {
  init: RequestInit & { signal?: AbortSignal }
  originalInit: RequestInit & { signal?: AbortSignal }
  cacheKey: string | null
  injected: boolean
} {
  const originalInit = init
  const effort = configuredReasoningEffort()
  if (!effort || String(init.method ?? 'GET').toUpperCase() !== 'POST' || typeof init.body !== 'string') {
    return { init, originalInit, cacheKey: null, injected: false }
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return { init, originalInit, cacheKey: null, injected: false }
  }
  if (!parsedUrl.pathname.endsWith('/chat/completions')) {
    return { init, originalInit, cacheKey: null, injected: false }
  }

  let body: Record<string, unknown>
  try {
    const parsed = JSON.parse(init.body) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { init, originalInit, cacheKey: null, injected: false }
    }
    body = parsed as Record<string, unknown>
  } catch {
    return { init, originalInit, cacheKey: null, injected: false }
  }

  // Respect any caller that intentionally supplied a provider-specific value.
  if (Object.prototype.hasOwnProperty.call(body, 'reasoning_effort')) {
    return { init, originalInit, cacheKey: null, injected: false }
  }

  const model = typeof body.model === 'string' ? body.model : ''
  if (!model) return { init, originalInit, cacheKey: null, injected: false }
  const cacheKey = `${parsedUrl.origin}:${model}`
  if (reasoningCapabilityCache.get(cacheKey) === 'unsupported') {
    return { init, originalInit, cacheKey, injected: false }
  }

  return {
    originalInit,
    cacheKey,
    injected: true,
    init: {
      ...init,
      body: JSON.stringify({ ...body, reasoning_effort: effort }),
    },
  }
}

function isReasoningCompatibilityError(res: Response, bodyText: string): boolean {
  if (res.status !== 400) return false
  const text = bodyText.toLowerCase()
  if (!text.includes('reasoning_effort')) return false
  return [
    'not supported',
    'unsupported',
    'unknown',
    'unrecognized',
    'not allowed',
    'not permitted',
    'invalid parameter',
    'invalid_request',
    'extra_forbidden',
    'function tools',
  ].some((needle) => text.includes(needle))
}

function ensureNoCustomRedirect(custom: boolean, res: Response): Response {
  if (custom && res.status >= 300 && res.status < 400) {
    throw new AiError(
      'The endpoint responded with a redirect, which the outbound policy does not allow.',
      { code: 'endpoint_blocked', status: 502 },
    )
  }
  return res
}

/** Test-only reset; harmless in production and keeps capability tests isolated. */
export function resetReasoningCapabilityCacheForTests(): void {
  reasoningCapabilityCache.clear()
}

/**
 * The single outbound gate every adapter provider call must use.
 *
 *  • Fixed preset roots (code-defined official hostnames) take the
 *    plain path — zero behavioral change, zero extra lookups.
 *  • Custom roots (admin-supplied gateways, e.g.
 *    `https://api.b.ai/v1/`) run the full SSRF policy BEFORE any
 *    request: scheme/port/credential/fragment validation and DNS
 *    answers classified in bulk (private/loopback/metadata/CGNAT/
 *    TEST-NET blocked unless the deployment opts into private
 *    endpoints). 3xx replies are refused (`redirect: 'manual'`) —
 *    a gateway must not bounce us to an unvalidated target.
 *
 * OpenAI-compatible chat/completions requests also negotiate the optional
 * `reasoning_effort` capability. In auto mode we optimistically request
 * `low` for CRM latency. If a provider/model explicitly rejects that field,
 * the exact request is retried once without it and the unsupported result is
 * cached for this process. No model ids or providers are hard-coded.
 *
 * Residual (documented in the Phase 05 report): the policy's DNS
 * view can race with the OS resolver (TOCTOU). Mitigated by:
 * private endpoints behind an extra explicit flag + exact-host
 * allowlist + the operator's own network (self-host), and by
 * HTTPS-only; full connection pinning is reserved for custom
 * roots only. Fixed roots are not affected at all.
 */
export async function providerFetch(
  ctx: AdapterContext,
  url: string,
  init: RequestInit & { signal?: AbortSignal },
): Promise<Response> {
  const custom = ctx.customEndpoint === true
  if (custom) {
    const allowPrivate = process.env.AI_PRIVATE_ENDPOINTS_ENABLED === 'true'
    const v = validateUrl(url, { allowPrivate })
    if (v.blockedReason || !v.url) {
      throw new AiError(
        `The endpoint address is blocked by the outbound security policy (${v.blockedReason ?? 'unparseable'}).`,
        { code: 'endpoint_blocked', status: 502 },
      )
    }
    const target = await resolveTarget(v.url, { allowPrivate })
    if (!target.allowed) {
      throw new AiError(
        `The endpoint address is blocked by the outbound security policy (${target.reason}).`,
        { code: 'endpoint_blocked', status: 502 },
      )
    }
  }

  const negotiated = maybeAddReasoningEffort(url, init)
  const requestInit = custom ? { ...negotiated.init, redirect: 'manual' as const } : negotiated.init
  let res = ensureNoCustomRedirect(custom, await fetch(url, requestInit))

  if (negotiated.injected && negotiated.cacheKey) {
    if (res.ok) {
      reasoningCapabilityCache.set(negotiated.cacheKey, 'supported')
    } else if (res.status === 400) {
      const errorText = await res.clone().text().catch(() => '')
      if (isReasoningCompatibilityError(res, errorText)) {
        reasoningCapabilityCache.set(negotiated.cacheKey, 'unsupported')
        const retryInit = custom
          ? { ...negotiated.originalInit, redirect: 'manual' as const }
          : negotiated.originalInit
        res = ensureNoCustomRedirect(custom, await fetch(url, retryInit))
      }
    }
  }

  return res
}

/**
 * Coerce a provider's usage block into our normalized `AiUsage`, tolerant
 * of missing/partial fields (providers differ and older API versions may
 * omit counts). Returns null when there's nothing usable, so logging can
 * distinguish "no usage reported" from "zero tokens". `total` falls back
 * to prompt + completion when the provider doesn't send it (Anthropic).
 */
export function normalizeUsage(raw: {
  prompt?: unknown
  completion?: unknown
  total?: unknown
}): AiUsage | null {
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
  const promptTokens = num(raw.prompt)
  const completionTokens = num(raw.completion)
  const total = num(raw.total)
  const totalTokens = total > 0 ? total : promptTokens + completionTokens
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null
  }
  return { promptTokens, completionTokens, totalTokens }
}

/** Map a fetch rejection (timeout / DNS / offline) to a typed AiError. */
export function toNetworkError(err: unknown): AiError {
  // Preserve errors already classified by the outbound/provider layer.
  // In particular, endpoint_blocked must not be relabelled as a generic
  // network error because operators need to know that the request never
  // reached the upstream provider.
  if (err instanceof AiError) return err

  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new AiError('The AI provider took too long to respond.', {
      code: 'timeout',
      status: 504,
    })
  }
  const msg = err instanceof Error ? err.message : String(err)
  return new AiError(`Could not reach the AI provider: ${msg}`, {
    code: 'network_error',
    status: 502,
  })
}

/** Build a typed AiError from a non-2xx provider response, pulling the
 *  provider's own error message out of the JSON body when present. */
export async function providerHttpError(
  provider: string,
  res: Response,
): Promise<AiError> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string } | string }
    detail =
      typeof body?.error === 'string'
        ? body.error
        : (body?.error?.message ?? '')
  } catch {
    // Non-JSON error body — fall back to the status line.
  }

  const { status } = res
  const code =
    status === 401 || status === 403
      ? 'invalid_key'
      : status === 429
        ? 'rate_limited'
        : 'provider_error'
  const base =
    code === 'invalid_key'
      ? `${provider} rejected the API key`
      : code === 'rate_limited'
        ? `${provider} rate limit reached`
        : `${provider} API error (${status})`

  return new AiError(detail ? `${base}: ${detail}` : base, {
    code,
    // Surface an auth failure as 401 so the settings "Test key" button
    // can show "invalid key"; everything else is an upstream 502.
    status: code === 'invalid_key' ? 401 : 502,
  })
}

/**
 * Collapse consecutive same-role turns into one (joined with blank
 * lines). Anthropic requires strictly alternating roles; merging is
 * also harmless for OpenAI and keeps the transcript compact.
 */
export function mergeConsecutive(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}
