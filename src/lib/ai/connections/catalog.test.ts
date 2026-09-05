import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { refreshCatalog } from './catalog'
import { packCatalogEnvelope } from '../providers/normalize'
import type { ConnectionRow } from './types'

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
  encrypt: (v: string) => `gcm:${v}`,
  isLegacyFormat: () => false,
}))

const FP = 'fp_conn1'

function connectionRow(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: 'conn-1',
    account_id: 'acct-1',
    name: 'X',
    preset_id: 'openai',
    protocol: 'openai',
    api_root: 'https://api.openai.com/v1/',
    encrypted_api_key: 'gcm:whatever',
    connection_fingerprint: FP,
    status: 'unverified',
    catalog: null,
    catalog_fetched_at: null,
    catalog_error_code: null,
    verified_at: null,
    created_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

interface DbBehavior {
  row: ConnectionRow
  updates: Array<Record<string, unknown>>
  fingerprintAfter?: string // simulate concurrent edit
}

function mockDb(b: DbBehavior): SupabaseClient {
  let reads = 0
  const table = {
    from: () => table,
    select: () => table,
    eq: () => table,
    order: () => table,
    update: (payload: Record<string, unknown>) => {
      b.updates.push(payload)
      return table
    },
    maybeSingle: () => {
      reads += 1
      // Reads: 1 = initial row load, 2 = decrypt-for-call, 3 = the
      // post-fetch fingerprint re-check. A concurrent edit landing
      // mid-request shows up only from read 3 onward.
      const fp =
        b.fingerprintAfter && reads >= 3 ? b.fingerprintAfter : b.row.connection_fingerprint
      return Promise.resolve({
        data: { ...b.row, connection_fingerprint: fp },
        error: null,
      })
    },
  }
  return table as unknown as SupabaseClient
}

function okList(models: { id: string }[]): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: null,
    json: async () => ({ data: models }),
    text: async () => JSON.stringify({ data: models }),
  } as unknown as Response
}

afterEach(() => vi.unstubAllGlobals())

const NOW = Date.parse('2026-09-04T12:00:00Z')
const opts = { now: () => NOW }

describe('refreshCatalog', () => {
  it('serves a FRESH cache without any provider call (FR-MOD-10)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const env = packCatalogEnvelope(
      {
        models: [{ id: 'm1', capabilities: { chat: 'unknown', embeddings: 'unknown', modelDiscovery: 'supported' } }],
        fetchedAt: new Date(NOW - 60_000).toISOString(),
        source: 'provider',
        completeness: 'complete',
      },
      FP,
    )
    const b: DbBehavior = { row: connectionRow({ catalog: env }), updates: [] }
    const res = await refreshCatalog(mockDb(b), 'acct-1', 'conn-1', opts)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.stale).toBe(false)
    expect(res.catalog?.source).toBe('cache')
    expect(res.connectionOk).toBe(true)
  })

  it('refreshes + persists envelope, clears error code, verifies connection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okList([{ id: 'deepseek-chat' }])))
    const b: DbBehavior = { row: connectionRow(), updates: [] }
    const res = await refreshCatalog(mockDb(b), 'acct-1', 'conn-1', opts)
    expect(res.stale).toBe(false)
    expect(res.catalog?.models.map((m) => m.id)).toEqual(['deepseek-chat'])
    const persisted = b.updates[0]
    expect((persisted.catalog as { fingerprint: string }).fingerprint).toBe(FP)
    expect(persisted.catalog_error_code).toBeNull()
    expect(persisted.status).toBe('verified')
  })

  it('failed refresh KEEPS the last good catalog, marked stale (FR-MOD-06)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: { message: 'slow down' } }), headers: new Headers() }))
    const env = packCatalogEnvelope(
      {
        models: [{ id: 'old-model', capabilities: { chat: 'unknown', embeddings: 'unknown', modelDiscovery: 'supported' } }],
        fetchedAt: new Date(NOW - 20 * 60 * 1000).toISOString(), // expired
        source: 'provider',
        completeness: 'complete',
      },
      FP,
    )
    const b: DbBehavior = { row: connectionRow({ catalog: env, status: 'verified' }), updates: [] }
    const res = await refreshCatalog(mockDb(b), 'acct-1', 'conn-1', opts)
    expect(res.stale).toBe(true)
    expect(res.errorCode).toBe('AI_RATE_LIMITED')
    expect(res.catalog?.models[0].id).toBe('old-model') // not erased
    expect(res.catalog?.source).toBe('cache')
    // Persistence must NOT touch the catalog column — only error state.
    expect(b.updates[0]).not.toHaveProperty('catalog')
    expect(b.updates[0].catalog_error_code).toBe('AI_RATE_LIMITED')
    expect(b.updates[0].status).toBe('error')
  })

  it('fingerprint change mid-flight skips persisting a stale result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okList([{ id: 'm' }])))
    const b: DbBehavior = { row: connectionRow(), updates: [], fingerprintAfter: 'fp_rotated' }
    const res = await refreshCatalog(mockDb(b), 'acct-1', 'conn-1', opts)
    expect(res.stale).toBe(true)
    expect(res.errorCode).toBe('AI_CONFIG_CONFLICT') // docs §13 stale-write semantics
    expect(b.updates[0]).not.toHaveProperty('catalog') // no catalog write
  })

  it('coalesces concurrent refreshes into one provider call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okList([{ id: 'm1' }]))
    vi.stubGlobal('fetch', fetchMock)
    const b: DbBehavior = { row: connectionRow(), updates: [] }
    const [r1, r2] = await Promise.all([
      refreshCatalog(mockDb(b), 'acct-1', 'conn-1', opts),
      refreshCatalog(mockDb(b), 'acct-1', 'conn-1', opts),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r1).toEqual(r2) // same shared in-flight result
  })

  it('force_refresh bypasses a fresh cache (explicit admin action)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okList([{ id: 'fresh' }]))
    vi.stubGlobal('fetch', fetchMock)
    const env = packCatalogEnvelope(
      {
        models: [{ id: 'cached', capabilities: { chat: 'unknown', embeddings: 'unknown', modelDiscovery: 'supported' } }],
        fetchedAt: new Date(NOW - 1000).toISOString(),
        source: 'provider',
        completeness: 'complete',
      },
      FP,
    )
    const b: DbBehavior = { row: connectionRow({ catalog: env }), updates: [] }
    const res = await refreshCatalog(mockDb(b), 'acct-1', 'conn-1', { ...opts, force: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res.catalog?.models[0].id).toBe('fresh')
  })
})
