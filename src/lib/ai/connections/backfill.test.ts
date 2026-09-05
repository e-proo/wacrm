import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { backfillProviderConnections } from './backfill'

// Mock the encryption helpers so assertions don't depend on real crypto.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
  encrypt: (v: string) => `gcm:${v}`,
  isLegacyFormat: (v: string) => !v.startsWith('gcm:'),
}))
vi.mock('./service', () => ({
  devFingerprint: () => 'fp_testmock',
  ConnectionService: class {},
}))

interface MockDbState {
  legacyRows: Array<Record<string, unknown>>
  /** connection rows already present in the table */
  existing: Array<Record<string, unknown>>
  /** rows inserted during the run */
  inserted: Array<Record<string, unknown>>
  /** ai_configs update patches applied by the embeddings link step */
  configUpdates: Array<Record<string, unknown>>
}

let connSeq = 0

/**
 * Minimal in-memory SupabaseClient-ish object.
 * - `from('ai_configs').select()` → returns all legacy rows.
 * - `from('ai_configs').update(patch).eq('id').is(...)` → records patch.
 * - `from('ai_provider_connections').select().eq().eq().maybeSingle()`
 *   → returns the first existing connection for the account.
 * - `from('ai_provider_connections').insert(row).select('id').single()`
 *   → records the row and returns it with a synthetic id.
 */
function makeDb(state: MockDbState): SupabaseClient {
  return {
    from(table: string) {
      if (table === 'ai_configs') {
        return {
          select: () =>
            Promise.resolve({ data: state.legacyRows, error: null }),
          update: (patch: Record<string, unknown>) => {
            state.configUpdates.push(patch)
            return {
              eq: () => ({ is: () => Promise.resolve({ error: null }) }),
            }
          },
        }
      }
      if (table === 'ai_provider_connections') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: state.existing[0] ?? null,
                    error: null,
                  }),
              }),
            }),
          }),
          insert: (row: Record<string, unknown>) => {
            const stored = { ...row, id: `conn-${++connSeq}` }
            state.inserted.push(stored)
            return {
              select: () => ({
                single: () => Promise.resolve({ data: stored, error: null }),
              }),
            }
          },
        }
      }
      return { select: () => ({}) }
    },
  } as unknown as SupabaseClient
}

describe('backfillProviderConnections', () => {
  it('creates Chat + Embedding connections when none exist and links the embeddings config', async () => {
    const state: MockDbState = {
      legacyRows: [
        {
          id: 'cfg-1',
          account_id: 'acct-1',
          provider: 'openai',
          api_key: 'old-gcm',
          embeddings_api_key: 'old-emb-gcm',
          is_active: true,
        },
      ],
      existing: [],
      inserted: [],
      configUpdates: [],
    }
    const result = await backfillProviderConnections(makeDb(state))
    expect(result.upserted).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.linked).toBe(1)
    const chat = state.inserted.find((r) => r.name === 'Assistant (Chat)')
    const emb = state.inserted.find((r) => r.name === 'Assistant (Embeddings)')
    expect(chat).toBeDefined()
    expect(emb).toBeDefined()
    expect(chat!.protocol).toBe('openai')
    // The plaintext produced by `decrypt` must never be persisted. The
    // mock decrypt returns "plain:<v>" and encrypt wraps as "gcm:<v>",
    // so the stored value is "gcm:plain:old-gcm" — re-encrypted, never the
    // legacy raw value and never the plaintext.
    expect(String(chat!.encrypted_api_key)).not.toMatch(/^plain:/)
    expect(String(chat!.encrypted_api_key)).toMatch(/^gcm:/)
    // The embeddings link points at the EMBEDDINGS connection and only
    // QUEUES a rebuild (state pending — semantic keeps running on the
    // legacy key until re-index activates the new revision).
    const link = state.configUpdates[0]
    expect(link.embedding_connection_id).toBe(emb!.id)
    expect(link.embedding_model).toBe('text-embedding-3-small')
    expect(link.embedding_dimensions).toBe(1536)
    expect(link.embedding_reindex_state).toBe('pending')
    expect(String(link.embedding_pending_revision)).toMatch(/^rev_[0-9a-f]{16}$/)
  })

  it('is idempotent: second pass skips existing rows', async () => {
    const state: MockDbState = {
      legacyRows: [
        {
          id: 'cfg-1',
          account_id: 'acct-1',
          provider: 'openai',
          api_key: 'old-gcm',
          embeddings_api_key: null,
          is_active: true,
        },
      ],
      existing: [{ id: 'conn-existing', preset_id: 'openai' }],
      inserted: [],
      configUpdates: [],
    }
    const result = await backfillProviderConnections(makeDb(state))
    expect(result.upserted).toBe(0)
    expect(result.skipped).toBe(1)
    expect(state.inserted).toHaveLength(0)
  })

  it('never re-links a config that already points at a connection', async () => {
    const state: MockDbState = {
      legacyRows: [
        {
          id: 'cfg-1',
          account_id: 'acct-1',
          provider: 'openai',
          api_key: 'old-gcm',
          embeddings_api_key: 'old-emb-gcm',
          embedding_connection_id: 'conn-user-chose', // admin already picked
          is_active: true,
        },
      ],
      existing: [{ id: 'conn-1' }, { id: 'conn-2' }],
      inserted: [],
      configUpdates: [],
    }
    const result = await backfillProviderConnections(makeDb(state))
    expect(state.configUpdates).toHaveLength(0)
    expect(result.detail.some((d) => d.kind === 'link' && d.action === 'already')).toBe(true)
  })

  it('re-encrypts legacy CBC-format keys to GCM', async () => {
    const state: MockDbState = {
      legacyRows: [
        {
          id: 'cfg-1',
          account_id: 'acct-1',
          provider: 'anthropic',
          api_key: 'legacy-cbc', // isLegacyFormat → true
          embeddings_api_key: null,
          is_active: true,
        },
      ],
      existing: [],
      inserted: [],
      configUpdates: [],
    }
    const result = await backfillProviderConnections(makeDb(state))
    expect(result.upserted).toBe(1)
    expect(state.inserted[0].encrypted_api_key).toBe('gcm:plain:legacy-cbc')
    expect(state.inserted[0].protocol).toBe('anthropic')
  })

  it('does not create embeddings connection when keys are identical, links chat conn', async () => {
    const state: MockDbState = {
      legacyRows: [
        {
          id: 'cfg-1',
          account_id: 'acct-1',
          provider: 'openai',
          api_key: 'same-key',
          embeddings_api_key: 'same-key', // identical → reuse chat conn
          is_active: true,
        },
      ],
      existing: [],
      inserted: [],
      configUpdates: [],
    }
    const result = await backfillProviderConnections(makeDb(state))
    expect(result.upserted).toBe(1) // chat only, no embed
    const names = state.inserted.map((r) => r.name)
    expect(names).toEqual(['Assistant (Chat)'])
    // OpenAI same-key DOES get linked (its chat conn can embed).
    expect(state.configUpdates[0].embedding_connection_id).toBe(state.inserted[0].id)
  })

  it('skips the link for anthropic chat with an identical (impossible-but-guarded) key', async () => {
    const state: MockDbState = {
      legacyRows: [
        {
          id: 'cfg-1',
          account_id: 'acct-1',
          provider: 'anthropic',
          api_key: 'same-key',
          embeddings_api_key: 'same-key',
          is_active: true,
        },
      ],
      existing: [],
      inserted: [],
      configUpdates: [],
    }
    const result = await backfillProviderConnections(makeDb(state))
    expect(result.upserted).toBe(1) // chat only
    expect(result.linked).toBe(0)
    expect(state.configUpdates).toHaveLength(0)
  })
})
