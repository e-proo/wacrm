import type { ProviderProtocol } from '../providers/contract'

// ============================================================
// Connection domain model.
//
// SafeConnection is the DTO that may cross a trust boundary (it is
// what GET /api/ai/connections returns). RuntimeConnection is
// server-only: it carries the decrypted key and must never be
// serialized or logged.
// ============================================================

export type ConnectionStatus = 'unverified' | 'verified' | 'error' | 'disabled'

/** Safe DTO — may be sent to the client. Never contains the key. */
export interface SafeConnection {
  id: string
  name: string
  presetId: string
  protocol: ProviderProtocol
  apiRoot: string
  /** Derived from the stored preset id (UI: read-only vs editable root). */
  apiRootMode: 'fixed' | 'custom'
  hasKey: boolean
  status: ConnectionStatus
  verifiedAt: string | null
  catalogFetchedAt: string | null
  catalogStale: boolean
  catalogErrorCode: string | null
  createdAt: string
  updatedAt: string
}

/** Server-only. Lives only in memory for the duration of a request. */
export interface RuntimeConnection {
  id: string
  accountId: string
  presetId: string
  protocol: ProviderProtocol
  apiRoot: URL
  apiKey: string
  /** Opaque, non-reversible fingerprint used for cache invalidation. */
  fingerprint: string
  /** Derived server-side from the PRESET id (never from client input):
   *  true ⇒ every outbound call passes the outbound SSRF policy. */
  customEndpoint: boolean
}

/** DB row type as read from the table. */
export interface ConnectionRow {
  id: string
  account_id: string
  name: string
  preset_id: string
  protocol: string
  api_root: string
  encrypted_api_key: string
  connection_fingerprint: string
  status: ConnectionStatus
  catalog: unknown | null
  catalog_fetched_at: string | null
  catalog_error_code: string | null
  verified_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/** Narrow selection list for the safe DTO — never includes the key. */
export const CONNECTION_SAFE_COLUMNS = [
  'id',
  'name',
  'preset_id',
  'protocol',
  'api_root',
  'status',
  'catalog_fetched_at',
  'catalog_error_code',
  'verified_at',
  'created_at',
  'updated_at',
] as const
