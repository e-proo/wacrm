/**
 * OW14-W07-03: pure validation and safe response contracts for server-only
 * owner/admin endpoints. No database client or provider transport belongs here.
 *
 * WARNING: requested activation is NOT dispatch authorization. The W07-04
 * outbound gate, OW14 release gate, manual STOP and recipient policy are
 * independent prerequisites. Mutating accept/enable stays disabled by default
 * until a separately authorized deployment enables this API stage.
 */

export const OPENWA_CONTROL_NO_STORE = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Vary': 'Cookie',
} as const

export const OPENWA_CONTROL_STAGE_ENV = 'WACRM_W07_CONTROL_WRITES_ENABLED'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DIGEST = /^[a-f0-9]{64}$/
const MAX_REVISION = Number.MAX_SAFE_INTEGER

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'invalid_request' }

export type PolicyMutation =
  | {
    action: 'accept'
    policy_version: string
    policy_digest: string
    acknowledge_risks: true
    expected_revision: number
    request_id: string
  }
  | {
    action: 'revoke'
    expected_revision: number
    request_id: string
  }

export type ActivationMutation =
  | {
    action: 'enable'
    confirm_activation: true
    expected_revision: number
    request_id: string
  }
  | {
    action: 'disable' | 'suspend'
    expected_revision: number
    request_id: string
  }

export function isOpenWAControlUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
}

function revisionIsValid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) &&
    value >= 0 && value < MAX_REVISION
}

export function parseOpenWAPolicyMutation(value: unknown): ParseResult<PolicyMutation> {
  const invalid = { ok: false, code: 'invalid_request' } as const
  if (!plainObject(value) || !revisionIsValid(value.expected_revision) ||
      !isOpenWAControlUuid(value.request_id)) return invalid
  if (value.action === 'revoke') {
    if (!exactKeys(value, ['action', 'expected_revision', 'request_id'])) return invalid
    return { ok: true, value: {
      action: 'revoke', expected_revision: value.expected_revision, request_id: value.request_id,
    } }
  }
  if (value.action !== 'accept' ||
      !exactKeys(value, ['action', 'policy_version', 'policy_digest',
        'acknowledge_risks', 'expected_revision', 'request_id']) ||
      value.acknowledge_risks !== true ||
      typeof value.policy_version !== 'string' || value.policy_version.length < 8 ||
      value.policy_version.length > 120 ||
      value.policy_version.startsWith('ow14-w07-draft-') ||
      typeof value.policy_digest !== 'string' || !DIGEST.test(value.policy_digest)
  ) return invalid
  return { ok: true, value: {
    action: 'accept',
    policy_version: value.policy_version,
    policy_digest: value.policy_digest,
    acknowledge_risks: true,
    expected_revision: value.expected_revision,
    request_id: value.request_id,
  } }
}

export function parseOpenWAActivationMutation(value: unknown): ParseResult<ActivationMutation> {
  const invalid = { ok: false, code: 'invalid_request' } as const
  if (!plainObject(value) || !revisionIsValid(value.expected_revision) ||
      !isOpenWAControlUuid(value.request_id)) return invalid
  if (value.action === 'enable') {
    if (!exactKeys(value, ['action', 'confirm_activation', 'expected_revision', 'request_id']) ||
        value.confirm_activation !== true) return invalid
    return { ok: true, value: {
      action: 'enable', confirm_activation: true,
      expected_revision: value.expected_revision, request_id: value.request_id,
    } }
  }
  if (value.action !== 'disable' && value.action !== 'suspend') return invalid
  if (!exactKeys(value, ['action', 'expected_revision', 'request_id'])) return invalid
  return { ok: true, value: {
    action: value.action,
    expected_revision: value.expected_revision, request_id: value.request_id,
  } }
}

/** Require JSON + an exact trusted same-origin browser POST. Origin cannot be
 * inferred from a user-supplied host header in production. Missing/invalid
 * NEXT_PUBLIC_SITE_URL fails closed in production, including behind proxies.
 */
export function isOpenWAControlSameOrigin(request: Request): boolean {
  const contentType = request.headers.get('content-type') ?? ''
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) return false
  const origin = request.headers.get('origin')
  if (!origin || origin === 'null') return false
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (process.env.NODE_ENV === 'production' && !configured) return false
  try {
    const allowed = new URL(configured || request.url)
    const actual = new URL(origin)
    // URL.origin alone allows mixed HTTP semantics on localhost. In
    // production, require a real HTTPS origin; local development can use HTTP.
    if (process.env.NODE_ENV === 'production' && allowed.protocol !== 'https:') return false
    return origin === actual.origin && actual.origin === allowed.origin
  } catch {
    return false
  }
}

/**
 * Draft "accept" or connection "enable" is dangerous to expose until the
 * send-time gate is installed. This independent server switch defaults OFF.
 * Revocation, disable, suspend remain available to resolve incidents.
 */
export function canWriteOpenWAControl(action: 'accept' | 'revoke' | 'enable' | 'disable' | 'suspend'): boolean {
  if (action === 'revoke' || action === 'disable' || action === 'suspend') return true
  return process.env.WACRM_W07_CONTROL_WRITES_ENABLED === 'true'
}

const SAFE_REASONS = new Set([
  'invalid_request', 'actor_forbidden', 'account_not_found',
  'connection_scope_mismatch', 'policy_not_approved', 'consent_required',
  'consent_not_active', 'session_not_ready', 'revision_conflict',
  'request_conflict', 'already_accepted', 'already_current',
  'already_disabled',
])

export interface ControlOutcome {
  updated?: unknown
  idempotent?: unknown
  status?: unknown
  revision?: unknown
  reason?: unknown
}

export function mapOpenWAControlOutcome(data: unknown): {
  status: number
  body: Record<string, unknown>
} {
  if (!plainObject(data)) {
    return { status: 503, body: { code: 'control_unavailable', error: 'OpenWA control is unavailable' } }
  }
  const input = data as ControlOutcome
  const revision = typeof input.revision === 'number' &&
    Number.isSafeInteger(input.revision) && input.revision >= 0
    ? input.revision : null
  if (input.updated === true && (input.status === 'accepted' || input.status === 'revoked' ||
    input.status === 'enabled' || input.status === 'disabled' || input.status === 'suspended')) {
    return { status: 200, body: {
      applied: true, recorded_status: input.status, revision,
      // Neither an active send permission nor proof of delivery.
      send_authorized: false, state_requires_refresh: true,
    } }
  }
  if (input.idempotent === true && (input.status === 'accepted' || input.status === 'revoked' ||
    input.status === 'enabled' || input.status === 'disabled' || input.status === 'suspended')) {
    return { status: 200, body: {
      applied: false, replayed: true, recorded_status: input.status, revision,
      send_authorized: false, state_requires_refresh: true,
    } }
  }
  const reason = typeof input.reason === 'string' && SAFE_REASONS.has(input.reason)
    ? input.reason : 'control_unavailable'
  const status = reason === 'invalid_request' ? 400
    : reason === 'actor_forbidden' ? 403
    : reason === 'account_not_found' || reason === 'connection_scope_mismatch' ? 404
    : reason === 'control_unavailable' ? 503 : 409
  return { status, body: {
    code: reason, error: reason === 'control_unavailable'
      ? 'OpenWA control is unavailable' : 'OpenWA control did not change; refresh the current state',
    ...(reason === 'revision_conflict' ? { revision } : {}),
    send_authorized: false,
  } }
}


/** A bounded, UTF-8 strict JSON reader. Chunked requests are limited too;
 * do not call Request.json() on an untrusted arbitrarily large body.
 */
export async function readOpenWAControlJson(request: Request): Promise<unknown> {
  const MAX_BYTES = 4096
  if (!request.body) return null
  const declared = request.headers.get('content-length')
  if (declared !== null && (Number(declared) > MAX_BYTES ||
      !Number.isSafeInteger(Number(declared)))) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
}
