import { createHash, randomBytes } from 'crypto'
import { encrypt } from '@/lib/whatsapp/encryption'
import type { SafeConnection, RuntimeConnection, ConnectionRow, ConnectionStatus } from './types'
import { getPreset, isCustomRootPreset } from '../providers/presets'
import { validateUrl } from '../outbound/url-policy'
import { ensureTrailingSlash } from '../outbound/url-join'

// ============================================================
// Connection service — server-only. Owns lifecycle of a provider
// connection: create / update / verify / test / disable / delete,
// plus the safe↔runtime conversion. All secret handling happens here
// and in `loader.ts`, never in a route.
// ============================================================

const FINGERPRINT_PREFIX = 'fp_'

export interface CreateConnectionInput {
  name: string
  presetId: string
  apiRoot?: string | null
  apiKey: string
  apiRootMode?: never
}

export interface UpdateConnectionInput {
  name?: string
  apiKey?: string | null
  apiRoot?: string | null
}

// ---- helpers -------------------------------------------------

/**
 * Compute an opaque, non-reversible fingerprint for a connection.
 * HMAC-SHA256 over (accountId, presetId, apiRoot, apiKey) using a
 * server-side key. Collisions imply a credential change → used for
 * cache invalidation in Phase 03+. Never returns plaintext.
 */
export function connectionFingerprint(
  accountId: string,
  presetId: string,
  apiRoot: string,
  apiKey: string,
): string {
  const salt = process.env.CONNECTION_FINGERPRINT_SALT
  const h = createHash('sha256')
  h.update(`${accountId}:${presetId}:${apiRoot}:${apiKey}:${salt ?? ''}`)
  return `${FINGERPRINT_PREFIX}${h.digest('hex').slice(0, 32)}`
}

/**
 * Dev-only fallback fingerprint that does not require an env salt.
 * Used only by the backfill path to seed an initial fingerprint; a
 * real rotate will recompute it server-side.
 */
export function devFingerprint(): string {
  return `${FINGERPRINT_PREFIX}${randomBytes(16).toString('hex')}`
}

function normalizeRoot(rawRoot: string | undefined, presetId: string): string {
  const preset = getPreset(presetId)
  if (preset.apiRootMode === 'fixed') {
    if (rawRoot && rawRoot.trim() !== '' && rawRoot !== preset.defaultApiRoot) {
      throw new Error(
        `Connection preset '${presetId}' is fixed-root; a custom API root cannot be accepted`,
      )
    }
    return preset.defaultApiRoot
  }
  // custom preset — format validation at SAVE (DNS/IP classification runs
  // on every REQUEST through the policy; refusing obvious junk here gives
  // the admin an immediate, precise error instead of a failed verify).
  const trimmed = (rawRoot ?? '').trim()
  if (!trimmed) {
    throw new Error('api_root is required for a custom connection')
  }
  if (trimmed.length > 512) {
    throw new Error('api_root is too long (max 512 characters)')
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('api_root must be a full URL, e.g. https://api.example.com/v1/')
  }
  const shape = validateUrl(trimmed, { allowPrivate: true }) // DNS still gated per request
  if (shape.blockedReason) {
    throw new Error(`api_root rejected by the endpoint policy: ${shape.error ?? shape.blockedReason}`)
  }
  return ensureTrailingSlash(parsed.toString())
}

export function toSafeConnection(row: ConnectionRow): SafeConnection {
  const fetchedAt = row.catalog_fetched_at
  const hasKey = !!row.encrypted_api_key
  const stale =
    !fetchedAt ||
    (row.catalog_error_code !== null && typeof row.catalog === 'object' && row.catalog !== null)
  return {
    id: row.id,
    name: row.name,
    presetId: row.preset_id,
    protocol: row.protocol as RuntimeConnection['protocol'],
    apiRoot: row.api_root,
    apiRootMode: isCustomRootPreset(row.preset_id) ? 'custom' : 'fixed',
    hasKey,
    status: row.status,
    verifiedAt: row.verified_at,
    catalogFetchedAt: fetchedAt,
    catalogStale: stale,
    catalogErrorCode: row.catalog_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface ServiceDeps {
  accountId: string
  userId: string
}

export class ConnectionService {
  // The service is a thin orchestrator; DB calls go through a
  // SupabaseClient supplied per request (RLS-scoped or service role).
  // CRUD + verification will be wired in the routes once the
  // outbound policy is live; this file holds the pure domain helpers
  // so they're unit-testable without Supabase.
  _deps: ServiceDeps

  constructor(deps: ServiceDeps) {
    this._deps = deps
  }

  /**
   * Build the encrypted persistence payload for a NEW connection.
   * Throws on fixed-root override or missing key.
   */
  buildCreate(row: {
    name: string
    presetId: string
    apiRoot?: string | null
    apiKey: string
  }): {
    name: string
    preset_id: string
    protocol: string
    api_root: string
    encrypted_api_key: string
    connection_fingerprint: string
  } {
    const { accountId } = this._deps
    const preset = getPreset(row.presetId)
    const apiRoot = normalizeRoot(row.apiRoot ?? undefined, row.presetId)

    const apiKey = row.apiKey.trim()
    if (!apiKey) throw new Error('api_key is required')

    const fingerprint = connectionFingerprint(accountId, row.presetId, apiRoot, apiKey)
    const encrypted = encrypt(apiKey)

    return {
      name: row.name.trim(),
      preset_id: row.presetId,
      protocol: preset.protocol,
      api_root: apiRoot,
      encrypted_api_key: encrypted,
      connection_fingerprint: fingerprint,
    }
  }

  /**
   * Build the update payload for an existing connection. Preserves
   * the existing key when none is supplied; re-encrypts and recomputes
   * the fingerprint when a new key or root is given. A key/root change
   * ALWAYS revokes the previous verification status (docs §7.3: it
   * “يلغي نتيجة التحقق السابقة ويجعل الكتالوج stale”) — the stored
   * catalog itself is kept and goes stale naturally via the fingerprint
   * check inside the cache envelope.
   */
  buildUpdate(
    existing: Pick<ConnectionRow, 'encrypted_api_key' | 'api_root' | 'preset_id'>,
    patch: UpdateConnectionInput,
  ): Record<string, unknown> {
    const { accountId } = this._deps
    const out: Record<string, unknown> = {}
    let credentialsChanged = false

    if (patch.name !== undefined) out.name = patch.name.trim()

    if (patch.apiRoot !== undefined) {
      const newRoot = normalizeRoot(patch.apiRoot ?? undefined, existing.preset_id)
      if (newRoot !== existing.api_root) {
        out.api_root = newRoot
        credentialsChanged = true
      }
    }

    if (patch.apiKey !== undefined) {
      if (patch.apiKey === null) {
        throw new Error('Clearing an encrypted key is a separate explicit action')
      }
      const newKey = patch.apiKey.trim()
      if (!newKey) throw new Error('api_key cannot be empty')
      credentialsChanged = true
      out.encrypted_api_key = encrypt(newKey)
      out.connection_fingerprint = connectionFingerprint(
        accountId,
        existing.preset_id,
        (out.api_root as string) ?? existing.api_root,
        newKey,
      )
    }

    if (credentialsChanged) {
      // Previous verified/error status no longer describes reality.
      out.status = 'unverified'
      out.verified_at = null
    }

    return out
  }
}

export { FINGERPRINT_PREFIX }
export type { ConnectionStatus }
