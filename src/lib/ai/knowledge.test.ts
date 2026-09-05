import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AiError } from './types'
import type { EmbeddingSetup } from './types'

const h = vi.hoisted(() => ({ embedTexts: vi.fn() }))
vi.mock('./embeddings', () => ({
  embedTexts: h.embedTexts,
  toVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
  EMBEDDING_DIMENSIONS: 1536,
}))

// Connection-side embedding + runtime loader (Phase 05 tests).
const hConn = vi.hoisted(() => ({
  embedVia: vi.fn(async (...args: unknown[]): Promise<number[][]> => {
    throw new Error(`embedVia not configured in this test (${args.length})`)
  }),
  loadRuntime: vi.fn(async (...args: unknown[]) => ({
    id: 'c-1',
    apiKey: `stub-${args.length}`,
  })),
}))
vi.mock('./connections/embed', () => ({
  embedTextsViaConnection: hConn.embedVia,
}))
vi.mock('./connections/loader', () => ({
  loadRuntimeConnection: hConn.loadRuntime,
}))

import { retrieveKnowledge, ingestDocument } from './knowledge'

interface FakeState {
  semantic: { id: string; content: string }[]
  fts: { id: string; content: string }[]
  chunkCount: number
  rpcCalls: string[]
  rpcArgs: Record<string, unknown>[]
  inserted: Record<string, unknown>[] | null
  deletedFor: string | null
  deletedRevisions: (string | null)[]
}

function makeDb() {
  const state: FakeState = {
    semantic: [],
    fts: [],
    chunkCount: 5, // account has a non-empty KB by default
    rpcCalls: [],
    rpcArgs: [],
    inserted: null,
    deletedFor: null,
    deletedRevisions: [],
  }
  const db = {
    rpc: (name: string, args?: Record<string, unknown>) => {
      state.rpcCalls.push(name)
      state.rpcArgs.push(args ?? {})
      if (name === 'match_ai_knowledge_semantic')
        return Promise.resolve({ data: state.semantic, error: null })
      if (name === 'match_ai_knowledge_fts')
        return Promise.resolve({ data: state.fts, error: null })
      return Promise.resolve({ data: null, error: null })
    },
    from: () => ({
      // retrieveKnowledge's empty-KB count guard.
      select: () => ({
        eq: () => Promise.resolve({ count: state.chunkCount, error: null }),
      }),
      // Delete chain: .eq('document_id', x) then .eq/.is('embedding_revision', …)
      delete: () => ({
        eq: (_col: string, val: string) => {
          const chain = {
            eq: (_c2: string, v2: string | null) => {
              if (_c2 === 'embedding_revision') state.deletedRevisions.push(v2)
              return Promise.resolve({ error: null })
            },
            is: (_c2: string, v2: string | null) => {
              if (_c2 === 'embedding_revision') state.deletedRevisions.push(v2)
              return Promise.resolve({ error: null })
            },
            then: (resolve: (v: { error: null }) => void) =>
              resolve({ error: null }),
          }
          state.deletedFor = val
          return chain
        },
      }),
      insert: (rows: Record<string, unknown>[]) => {
        state.inserted = rows
        return Promise.resolve({ error: null })
      },
    }),
  }
  return { db: db as unknown as SupabaseClient, state }
}

beforeEach(() => {
  h.embedTexts.mockReset()
  h.embedTexts.mockImplementation(async (_key: string, inputs: string[]) =>
    inputs.map((_, i) => [i, i]),
  )
  hConn.embedVia.mockReset()
  hConn.embedVia.mockImplementation(
    async (...args: unknown[]): Promise<number[][]> => {
      const inputs = args[2] as string[]
      return inputs.map((_, i) => [i, i])
    },
  )
  hConn.loadRuntime.mockReset()
  hConn.loadRuntime.mockImplementation(async () => ({ id: 'c-1', apiKey: 'k' }))
})

describe('retrieveKnowledge', () => {
  it('returns [] for an empty query without touching the DB', async () => {
    const { db, state } = makeDb()
    expect(await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, '  ')).toEqual([])
    expect(state.rpcCalls).toEqual([])
  })

  it('short-circuits (no embed, no RPC) when the KB is empty', async () => {
    const { db, state } = makeDb()
    state.chunkCount = 0
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q')
    expect(out).toEqual([])
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.rpcCalls).toEqual([])
  })

  it('uses lexical FTS only when there is no embeddings key', async () => {
    const { db, state } = makeDb()
    state.fts = [{ id: 'f1', content: 'F1' }]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: null }, 'q')
    expect(out).toEqual(['F1'])
    expect(state.rpcCalls).toEqual(['match_ai_knowledge_fts'])
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('uses semantic search when an embeddings key is present', async () => {
    const { db, state } = makeDb()
    state.semantic = [
      { id: 's1', content: 'S1' },
      { id: 's2', content: 'S2' },
      { id: 's3', content: 'S3' },
    ]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q', 3)
    expect(out).toEqual(['S1', 'S2', 'S3'])
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    // Enough semantic hits → no FTS top-up.
    expect(state.rpcCalls).toEqual(['match_ai_knowledge_semantic'])
  })

  it('tops up with FTS and dedupes when semantic is short', async () => {
    const { db, state } = makeDb()
    state.semantic = [
      { id: 's1', content: 'S1' },
      { id: 's2', content: 'S2' },
    ]
    state.fts = [
      { id: 's2', content: 'S2-dup' }, // dedup by id
      { id: 'f1', content: 'F1' },
    ]
    const out = await retrieveKnowledge(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'q', 3)
    expect(out).toEqual(['S1', 'S2', 'F1'])
    expect(state.rpcCalls).toEqual([
      'match_ai_knowledge_semantic',
      'match_ai_knowledge_fts',
    ])
  })
})

describe('ingestDocument', () => {
  it('embeds chunks when a key is present', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'hello world')
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    expect(state.deletedFor).toBe('doc-1')
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0].embedding).toBe('[0,0]') // literal from mocked embed
    expect(state.inserted![0].account_id).toBe('acct')
  })

  it('stores chunks without embeddings when there is no key', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: null }, 'doc-1', 'hello world')
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(state.inserted![0].embedding).toBeNull()
  })

  it('deletes existing chunks and inserts nothing for empty content', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', '   ')
    expect(state.deletedFor).toBe('doc-1')
    expect(state.inserted).toBeNull()
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('still stores lexical chunks when embedding fails, then rethrows', async () => {
    const { db, state } = makeDb()
    h.embedTexts.mockRejectedValueOnce(new Error('rate limited'))
    await expect(
      ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'hello world'),
    ).rejects.toThrow('rate limited')
    // Chunks were inserted (lexical search works) despite the embed failure…
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0].embedding).toBeNull()
  })

  it('legacy writes carry a NULL revision (the pre-connection space)', async () => {
    const { db, state } = makeDb()
    await ingestDocument(db, 'acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'hello world')
    expect(state.inserted![0].embedding_revision).toBeNull()
    // Deletion is scoped to the NULL space, so a connection-rebuilt
    // account's stamped rows can never be wiped by a legacy ingest.
    expect(state.deletedRevisions).toEqual([null])
  })
})

// ------------------------------------------------------------
// Phase 05 — connection-based KB: revision stamping, per-revision
// deletion, dual-read (legacy keeps serving until activation), the
// disabled state, and the dimension-mismatch no-write rule.
// ------------------------------------------------------------

type Setup = EmbeddingSetup
const connSetup = (over: Partial<Setup> = {}): Setup => ({
  embeddingConnectionId: 'c-1',
  embeddingModel: 'embedme',
  activeRevision: 'rev_live',
  pendingRevision: null,
  reindexState: 'ready',
  ...over,
})

describe('connection-based knowledge (Phase 05)', () => {
  it('retrieves through the connection with p_revision, even while a rebuild is building (previous stays live)', async () => {
    const { db, state } = makeDb()
    state.semantic = [{ id: 'r1', content: 'R1' }]
    const out = await retrieveKnowledge(
      db,
      'acct',
      {
        embeddingsApiKey: null,
        embeddingSetup: connSetup({ activeRevision: 'rev_live', pendingRevision: 'rev_new', reindexState: 'building' }),
      },
      'hello',
      1,
    )
    expect(out).toEqual(['R1'])
    expect(state.rpcCalls[0]).toBe('match_ai_knowledge_semantic')
    expect(state.rpcArgs[0].p_revision).toBe('rev_live')
    expect(hConn.embedVia).toHaveBeenCalledTimes(1)
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('dual-read: pending revision without an active one keeps the legacy key semantic space (no p_revision)', async () => {
    const { db, state } = makeDb()
    state.semantic = [{ id: 'legacy1', content: 'L1' }]
    const out = await retrieveKnowledge(
      db,
      'acct',
      {
        embeddingsApiKey: 'sk-x',
        embeddingSetup: connSetup({ activeRevision: null, pendingRevision: 'rev_new', reindexState: 'pending' }),
      },
      'q',
      1,
    )
    expect(out).toEqual(['L1'])
    expect(state.rpcArgs[0].p_revision).toBeUndefined()
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    expect(hConn.embedVia).not.toHaveBeenCalled()
  })

  it('"disabled" setup with no usable key falls back to lexical only', async () => {
    const { db, state } = makeDb()
    state.fts = [{ id: 'f1', content: 'F1' }]
    const out = await retrieveKnowledge(
      db,
      'acct',
      { embeddingsApiKey: null, embeddingSetup: connSetup({ reindexState: 'disabled' }) },
      'q',
    )
    expect(out).toEqual(['F1'])
    expect(state.rpcCalls).toEqual(['match_ai_knowledge_fts'])
  })

  it('ingest stamps the PENDING revision and deletes only THAT revision of the doc', async () => {
    const { db, state } = makeDb()
    await ingestDocument(
      db,
      'acct',
      { embeddingsApiKey: 'sk-x', embeddingSetup: connSetup({ pendingRevision: 'rev_new' }) },
      'doc-9',
      'hello world',
    )
    expect(state.deletedRevisions).toEqual(['rev_new'])
    expect(state.inserted![0].embedding_revision).toBe('rev_new')
    expect(state.inserted![0].embedding).toBe('[0,0]')
    // New writes go through the connection, never the legacy key.
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(hConn.embedVia).toHaveBeenCalledTimes(1)
  })

  it('dimension mismatch → NO vectors reach the table and the route sees the code', async () => {
    const { db, state } = makeDb()
    hConn.embedVia.mockRejectedValueOnce(
      new AiError('provider returned 3072', { code: 'embedding_dimension_mismatch', status: 400 }),
    )
    await expect(
      ingestDocument(db, 'acct', { embeddingsApiKey: null, embeddingSetup: connSetup() }, 'doc-9', 'hello world'),
    ).rejects.toMatchObject({ code: 'embedding_dimension_mismatch' })
    // Rows exist for lexical search, with embedding null (gate fired).
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted![0].embedding).toBeNull()
  })
})
