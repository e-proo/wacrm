import { describe, it, expect, vi, afterEach } from 'vitest'
import type { RuntimeConnection } from './types'
import {
  computeEmbeddingRevision,
  validateVectorsForIndex,
  embedTextsViaConnection,
  EMBEDDING_DIMENSIONS,
} from './embed'
import { AiError } from '../types'

function geminiJson(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: null,
  } as unknown as Response
}

function geminiConn(overrides: Partial<RuntimeConnection> = {}): RuntimeConnection {
  return {
    id: 'conn-g',
    accountId: 'acct-1',
    presetId: 'gemini',
    protocol: 'gemini_native',
    apiRoot: new URL('https://generativelanguage.googleapis.com/v1beta/'),
    apiKey: 'secret-not-logged-xyz',
    fingerprint: 'fp_x',
    customEndpoint: false,
    ...overrides,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('computeEmbeddingRevision', () => {
  it('is stable for identical inputs', () => {
    const a = computeEmbeddingRevision({
      protocol: 'openai',
      connectionId: 'c1',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    })
    const b = computeEmbeddingRevision({
      protocol: 'openai',
      connectionId: 'c1',
      model: 'TEXT-EMBEDDING-3-SMALL', // case-insensitive model
      dimensions: 1536,
    })
    expect(a).toBe(b)
    expect(a).toMatch(/^rev_[0-9a-f]{16}$/)
  })

  it('changes when any identity input changes', () => {
    const base = { protocol: 'openai', connectionId: 'c1', model: 'm', dimensions: 1536 }
    expect(computeEmbeddingRevision(base)).not.toBe(
      computeEmbeddingRevision({ ...base, model: 'm2' }),
    )
    expect(computeEmbeddingRevision(base)).not.toBe(
      computeEmbeddingRevision({ ...base, connectionId: 'c2' }),
    )
    expect(computeEmbeddingRevision(base)).not.toBe(
      computeEmbeddingRevision({ ...base, protocol: 'gemini_native' }),
    )
  })
})

describe('validateVectorsForIndex — the hard ADR-008 gate', () => {
  const vec = (len: number) => Array.from({ length: len }, () => 0.5)

  it('accepts exactly 1536×N finite numbers', () => {
    expect(() => validateVectorsForIndex([vec(EMBEDDING_DIMENSIONS), vec(EMBEDDING_DIMENSIONS)], 2)).not.toThrow()
  })

  it('rejects 1535 and 1537 before any DB touch (no truncate, no pad)', () => {
    for (const bad of [1535, 1537, 3072]) {
      expect(() => validateVectorsForIndex([vec(bad)], 1)).toThrowError(AiError)
      try {
        validateVectorsForIndex([vec(bad)], 1)
      } catch (err) {
        expect((err as AiError).code).toBe('embedding_dimension_mismatch')
      }
    }
  })

  it('rejects non-finite values', () => {
    const v = vec(1536)
    v[4] = Number.NaN
    try {
      validateVectorsForIndex([v], 1)
      expect.unreachable()
    } catch (err) {
      expect((err as AiError).code).toBe('embeddings_malformed')
    }
  })

  it('rejects count mismatch (ordering/loss detection, docs §12.4)', () => {
    try {
      validateVectorsForIndex([vec(1536)], 2)
      expect.unreachable()
    } catch (err) {
      expect((err as AiError).code).toBe('embeddings_malformed')
    }
  })
})

describe('embedTextsViaConnection', () => {
  it('rejects providers without an embed capability', async () => {
    const anthropicConn: RuntimeConnection = {
      ...geminiConn(),
      protocol: 'anthropic',
      presetId: 'anthropic',
    }
    await expect(
      embedTextsViaConnection(anthropicConn, 'any', ['x']),
    ).rejects.toMatchObject({ code: 'ai_unsupported_capability' })
  })

  it('OpenAI-shaped responses restore input order from data[].index', async () => {
    const vec3 = (v: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, () => v)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        geminiJson(200, {
          data: [
            { embedding: vec3(2), index: 1 },
            { embedding: vec3(1), index: 0 }, // provider returns them swapped
          ],
        }),
      ),
    )
    const out = await embedTextsViaConnection(
      geminiConn({ protocol: 'openai', presetId: 'openai' }),
      'text-embedding-3-small',
      ['a', 'b'],
    )
    expect(out[0][0]).toBe(1)
    expect(out[1][0]).toBe(2)
  })

  it('preserves input order and batches through the adapter', async () => {
    let n = 0
    const fetchMock = vi.fn(async () => {
      n += 1
      const values = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i + n)
      return geminiJson(200, { embedding: { values } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const out = await embedTextsViaConnection(
      geminiConn({ apiKey: 'k' }),
      'gemini-embedding-001',
      ['first', 'second'],
    )
    expect(out).toHaveLength(2)
    expect(out[0][0]).toBe(1) // first response
    expect(out[1][0]).toBe(2) // second response — order not swapped
  })

  it('maps a credential failure to the shared AiError code, not raw bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(geminiJson(401, { error: { message: 'bad' } })))
    await expect(
      embedTextsViaConnection(geminiConn(), 'm', ['x']),
    ).rejects.toMatchObject({ code: 'invalid_key' })
  })

  it('a provider returning 3072-dim vectors fails the gate with mismatch code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        geminiJson(200, { embedding: { values: Array.from({ length: 3072 }, () => 0.1) } }),
      ),
    )
    await expect(
      embedTextsViaConnection(geminiConn(), 'large-model', ['x']),
    ).rejects.toMatchObject({ code: 'embedding_dimension_mismatch' })
  })
})
