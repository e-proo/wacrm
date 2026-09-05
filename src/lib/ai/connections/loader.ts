// IMPORTANT: this module is server-only. Its callers are API routes
// and webhook engines; it decrypts provider secrets and therefore
// must never reach client bundles. The repo's convention (see
// src/lib/auth/account.ts) is to enforce that boundary by import
// placement rather than the `server-only` package.
import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { RuntimeConnection, ConnectionRow, SafeConnection } from './types'
import { catalogIsStale } from '../providers/normalize'
import { isCustomRootPreset } from '../providers/presets'

// ============================================================
// Server-only connection loader.
//
// Decrypts the stored key in the narrowest possible scope and
// returns a RuntimeConnection that is never serialized or logged.
// The decrypted plaintext lives only for the duration of the request.
// ============================================================

const LOADER_COLUMNS =
  'id, account_id, name, preset_id, protocol, api_root, encrypted_api_key, connection_fingerprint, status'

/**
 * Load a single connection for use on the server (generation, probes).
 * Throws if the row is missing, belongs to another account (RLS 404),
 * or the key cannot be decrypted.
 */
export async function loadRuntimeConnection(
  db: SupabaseClient,
  accountId: string,
  connectionId: string,
): Promise<RuntimeConnection> {
  const { data, error } = await db
    .from('ai_provider_connections')
    .select(LOADER_COLUMNS)
    .eq('id', connectionId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) throw error
  if (!data) {
    // Not-found is the same whether it doesn't exist or belongs to
    // another account — avoids leaking existence across accounts.
    const err = new Error('Connection not found')
    ;(err as { code?: string }).code = 'not_found'
    throw err
  }

  const row = data as ConnectionRow
  let apiKey: string
  try {
    apiKey = decrypt(row.encrypted_api_key)
  } catch {
    // Do not log ciphertext; surface a generic error.
    throw new Error('Stored API key could not be decrypted — re-enter your key')
  }

  const apiRoot = new URL(row.api_root)
  return {
    id: row.id,
    accountId: row.account_id,
    presetId: row.preset_id,
    protocol: row.protocol as RuntimeConnection['protocol'],
    apiRoot,
    apiKey,
    fingerprint: row.connection_fingerprint,
    // Derived from the STORED preset id, not from any request field.
    customEndpoint: isCustomRootPreset(row.preset_id),
  }
}

/**
 * Safe, client-facing DTO list. The `catalog` + `connection_fingerprint`
 * columns are read ONLY to derive the boolean `catalogStale` flag —
 * neither the envelope contents nor the fingerprint itself are ever
 * returned to the client (no key material, directly or derived).
 */
export async function listSafeConnections(
  db: SupabaseClient,
  accountId: string,
  nowMs: number = Date.now(),
): Promise<SafeConnection[]> {
  const columns =
    'id, account_id, name, preset_id, protocol, api_root, encrypted_api_key, connection_fingerprint, status, catalog, catalog_fetched_at, catalog_error_code, verified_at, created_at, updated_at'
  const { data, error } = await db
    .from('ai_provider_connections')
    .select(columns)
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })

  if (error) throw error
  const rows = (data ?? []) as ConnectionRow[]
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    presetId: row.preset_id,
    protocol: row.protocol as SafeConnection['protocol'],
    apiRoot: row.api_root,
    // Derived from the stored preset id — the form uses it to decide
    // whether the root field is read-only.
    apiRootMode: isCustomRootPreset(row.preset_id) ? 'custom' : 'fixed',
    // encrypted_api_key is NOT NULL — any stored row always has a key.
    hasKey: true,
    status: row.status,
    verifiedAt: row.verified_at,
    catalogFetchedAt: row.catalog_fetched_at,
    catalogStale: catalogIsStale(row.catalog, row.connection_fingerprint, nowMs),
    catalogErrorCode: row.catalog_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}
