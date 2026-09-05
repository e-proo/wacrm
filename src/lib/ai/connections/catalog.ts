import type { SupabaseClient } from '@supabase/supabase-js'
import { AiError } from '../types'
import { getAdapter } from '../providers/registry'
import {
  unpackCatalogEnvelope,
  packCatalogEnvelope,
  catalogIsFresh,
} from '../providers/normalize'
import type { ModelCatalog } from '../providers/model-types'
import { loadRuntimeConnection } from './loader'
import type { ConnectionRow } from './types'
import { aiRequestTimeoutMs } from '../defaults'

// ============================================================
// Catalog cache lifecycle on the connection row.
//
// Freshness identity: stored envelope carries the connection
// fingerprint and the normalizer version at fetch time. A key/root/
// protocol rotation changes the fingerprint → cached catalog is no
// longer accepted as fresh (docs §12.4). TTL is advisory; a failed
// refresh NEVER erases the last good catalog — it is served with
// `stale: true` plus a safe error code (FR-MOD-06).
// ============================================================

// Re-exported so callers/tests of Phase 02-era paths keep working.
export { CATALOG_TTL_MS, catalogIsFresh } from '../providers/normalize'

const CATALOG_SELECT =
  'id, account_id, preset_id, protocol, api_root, encrypted_api_key, connection_fingerprint, status, catalog, catalog_fetched_at, catalog_error_code, verified_at'

export interface CatalogRefreshResult {
  catalog: ModelCatalog | null
  stale: boolean
  /** Safe code when the refresh failed but a (stale) catalog survived. */
  errorCode: string | null
  /** True when the auth probe succeeded (models endpoint responded). */
  connectionOk: boolean
}

export interface RefreshOptions {
  force?: boolean
  now?: () => number
}

/** In-flight refresh dedupe: two concurrent admin clicks share one
 *  provider call (docs §7 concurrency gate). Cleared on settle. */
const inFlight = new Map<string, Promise<CatalogRefreshResult>>()

// ---- refresh orchestration ------------------------------------

/**
 * Refresh (or serve cached) models for one connection. MUST be called
 * from admin-gated server code. Never throws for recoverable provider
 * failures — returns a typed result so the route can keep semantics
 * stable between a fresh success and a stale-cache degraded success.
 */
export async function refreshCatalog(
  db: SupabaseClient,
  accountId: string,
  connectionId: string,
  opts: RefreshOptions = {},
): Promise<CatalogRefreshResult> {
  const key = `${accountId}:${connectionId}`
  const running = inFlight.get(key)
  if (running && !opts.force) return running
  const promise = runRefresh(db, accountId, connectionId, opts).finally(() =>
    inFlight.delete(key),
  )
  inFlight.set(key, promise)
  return promise
}

async function runRefresh(
  db: SupabaseClient,
  accountId: string,
  connectionId: string,
  opts: RefreshOptions,
): Promise<CatalogRefreshResult> {
  const now = opts.now?.() ?? Date.now()

  const { data, error } = await db
    .from('ai_provider_connections')
    .select(CATALOG_SELECT)
    .eq('id', connectionId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new AiError('Connection not found', { code: 'not_found', status: 404 })
  const row = data as ConnectionRow

  // Fresh cache + not forcing → serve provider-free (FR-MOD-10:
  // never fetch on every render/save).
  if (!opts.force) {
    const fresh = catalogIsFresh(row.catalog, row.connection_fingerprint, now)
    if (fresh) {
      return {
        catalog: { ...fresh.catalog, source: 'cache' },
        stale: false,
        errorCode: null,
        connectionOk: true,
      }
    }
  }

  // Attempt a live discovery. Secrets stay server-side: the runtime
  // object never leaves this function scope.
  const conn = await loadRuntimeConnection(db, accountId, connectionId)
  const adapter = getAdapter(conn.protocol)
  if (!adapter.listModels) {
    return finishWithStale(db, connectionId, row, 'model_discovery_unsupported')
  }

  try {
    const catalog = await adapter.listModels({
      apiKey: conn.apiKey,
      timeoutMs: aiRequestTimeoutMs(),
      apiRoot: conn.apiRoot,
      customEndpoint: conn.customEndpoint,
    })
    // Guard against a concurrent edit invalidating the row mid-flight
    // (docs §6 step 8): re-read the fingerprint and skip persistence
    // if it changed after we decrypted.
    const { data: current } = await db
      .from('ai_provider_connections')
      .select('connection_fingerprint')
      .eq('id', connectionId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!current || (current as Pick<ConnectionRow, 'connection_fingerprint'>).connection_fingerprint !== conn.fingerprint) {
      throw new AiError('The connection changed during refresh.', {
        code: 'connection_changed_during_refresh',
        status: 409,
      })
    }

    const envelope = packCatalogEnvelope(catalog, conn.fingerprint)
    const { error: upErr } = await db
      .from('ai_provider_connections')
      .update({
        catalog: envelope,
        catalog_fetched_at: catalog.fetchedAt,
        catalog_error_code: null,
        status: row.status === 'disabled' ? row.status : 'verified',
        verified_at: new Date(now).toISOString(),
      })
      .eq('id', connectionId)
      .eq('account_id', accountId)
    if (upErr) throw upErr
    return { catalog, stale: false, errorCode: null, connectionOk: true }
  } catch (err) {
    // Failure NEVER deletes the last good catalog (FR-MOD-06, §5.1).
    const safeCode = safeFailureCode(err)
    return finishWithStale(db, connectionId, row, safeCode)
  }
}

/** Mark the row degraded but keep whatever catalog exists. */
async function finishWithStale(
  db: SupabaseClient,
  connectionId: string,
  row: ConnectionRow,
  errorCode: string,
): Promise<CatalogRefreshResult> {
  const { error } = await db
    .from('ai_provider_connections')
    .update({
      catalog_error_code: errorCode,
      status: row.status === 'verified' ? 'error' : row.status,
    })
    .eq('id', connectionId)
    .eq('account_id', row.account_id)
  if (error) {
    console.error('[ai catalog] failed to persist refresh error state:', error)
  }
  const envelope = unpackCatalogEnvelope(row.catalog)
  // Serve the last good list flagged stale — the DTO carries `stale`,
  // not the internal ModelCatalog contract.
  const staleCatalog: ModelCatalog | null = envelope
    ? { ...envelope.catalog, source: 'cache' }
    : null
  return { catalog: staleCatalog, stale: true, errorCode, connectionOk: false }
}

/** Map internal errors to the public safe code space (§13). */
function safeFailureCode(err: unknown): string {
  if (err instanceof AiError) {
    switch (err.code) {
      case 'invalid_key':
        return 'AI_INVALID_CREDENTIALS'
      case 'rate_limited':
        return 'AI_RATE_LIMITED'
      case 'timeout':
        return 'AI_CONNECTION_TIMEOUT'
      case 'model_discovery_unsupported':
        return 'AI_MODEL_DISCOVERY_UNSUPPORTED'
      case 'connection_changed_during_refresh':
        return 'AI_CONFIG_CONFLICT'
      case 'network_error':
        return 'AI_PROVIDER_UNAVAILABLE'
      default:
        return 'AI_PROVIDER_MALFORMED_RESPONSE'
    }
  }
  return 'AI_INTERNAL_ERROR'
}
