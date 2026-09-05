import { describe, it, expect } from 'vitest'
import {
  normalizeOpenAiModels,
  packCatalogEnvelope,
  unpackCatalogEnvelope,
  catalogIsFresh,
  catalogIsStale,
  MAX_CATALOG_MODELS,
  CATALOG_TTL_MS,
} from './normalize'

describe('normalizeOpenAiModels', () => {
  it('normalizes a standard OpenAI payload', () => {
    const cat = normalizeOpenAiModels(
      {
        data: [
          { id: 'gpt-5.4-mini', created: 1, owned_by: 'openai' },
          { id: 'llama-3.3-70b', owned_by: 'deepseek' },
        ],
      },
      { now: () => '2026-09-04T00:00:00.000Z' },
    )
    expect(cat.models.map((m) => m.id)).toEqual(['gpt-5.4-mini', 'llama-3.3-70b'])
    expect(cat.models[0].capabilities).toEqual({
      chat: 'unknown',
      embeddings: 'unknown',
      modelDiscovery: 'supported',
    })
    expect(cat.source).toBe('provider')
    expect(cat.completeness).toBe('complete')
    expect(cat.fetchedAt).toBe('2026-09-04T00:00:00.000Z')
  })

  it('missing metadata stays `unknown`, never `unsupported` (ADR-005)', () => {
    const cat = normalizeOpenAiModels({ data: [{ id: 'mystery-model' }] })
    expect(cat.models[0].capabilities.chat).toBe('unknown')
    expect(cat.models[0].ownedBy).toBeUndefined()
  })

  it('dedupes ids case-sensitively, keeps the first occurrence', () => {
    const cat = normalizeOpenAiModels({
      data: [{ id: 'GPT-X' }, { id: 'gpt-x' }, { id: 'GPT-X' }],
    })
    expect(cat.models.map((m) => m.id)).toEqual(['GPT-X', 'gpt-x'])
  })

  it('stable sort by id (display ordering does not churn)', () => {
    const input = { data: [{ id: 'zulu' }, { id: 'alpha' }, { id: 'Mike' }, { id: 'mike' }] }
    const a = normalizeOpenAiModels(input)
    const b = normalizeOpenAiModels(input)
    expect(a.models.map((m) => m.id)).toEqual(b.models.map((m) => m.id))
  })

  it('caps the stored catalog (docs §12.4 max ~500)', () => {
    const huge = { data: Array.from({ length: MAX_CATALOG_MODELS + 120 }, (_, i) => ({ id: `m-${String(i).padStart(5, '0')}` })) }
    const cat = normalizeOpenAiModels(huge)
    expect(cat.models.length).toBe(MAX_CATALOG_MODELS)
    expect(cat.completeness).toBe('bounded')
  })

  it('drops oversized and blank ids instead of failing the catalog', () => {
    const cat = normalizeOpenAiModels({
      data: [{ id: 'x'.repeat(500) }, { id: '  ' }, { id: 'good' }],
    })
    expect(cat.models.map((m) => m.id)).toEqual(['good'])
  })

  it('throws on a payload without a data array (caller keeps old cache)', () => {
    expect(() => normalizeOpenAiModels(null)).toThrowError()
    expect(() => normalizeOpenAiModels({ models: [] } as never)).toThrowError()
  })
})

const NOW = Date.parse('2026-09-04T12:00:00Z')
function envelopeFor(fp: string, ts: string) {
  return packCatalogEnvelope(
    { models: [{ id: 'm1', capabilities: { chat: 'unknown', embeddings: 'unknown', modelDiscovery: 'supported' } }], fetchedAt: ts, source: 'provider', completeness: 'complete' },
    fp,
  )
}

describe('catalog envelope + freshness', () => {
  it('round-trips through the envelope', () => {
    const env = envelopeFor('fp_abc', '2026-09-04T11:00:00Z')
    const back = unpackCatalogEnvelope(JSON.parse(JSON.stringify(env)))
    expect(back?.fingerprint).toBe('fp_abc')
    expect(back?.catalog.models[0].id).toBe('m1')
  })

  it('rejects malformed envelopes as absent', () => {
    expect(unpackCatalogEnvelope(null)).toBeNull()
    expect(unpackCatalogEnvelope({ v: 999 })).toBeNull()
    expect(unpackCatalogEnvelope({ v: 1, fetchedAt: 'x', fingerprint: 'f', catalog: { models: 'oops' } })).toBeNull()
    expect(unpackCatalogEnvelope('garbage')).toBeNull()
  })

  it('fresh inside the TTL with a matching fingerprint', () => {
    const env = envelopeFor('fp_abc', new Date(NOW - 60_000).toISOString())
    expect(catalogIsFresh(env, 'fp_abc', NOW)).not.toBeNull()
    expect(catalogIsStale(env, 'fp_abc', NOW)).toBe(false)
  })

  it('expired past the 15-minute TTL', () => {
    const env = envelopeFor('fp_abc', new Date(NOW - CATALOG_TTL_MS - 1).toISOString())
    expect(catalogIsFresh(env, 'fp_abc', NOW)).toBeNull()
    expect(catalogIsStale(env, 'fp_abc', NOW)).toBe(true)
  })

  it('fingerprint rotation invalidates freshness WITHOUT erasing the cache', () => {
    const env = envelopeFor('fp_old', new Date(NOW - 1_000).toISOString())
    expect(catalogIsFresh(env, 'fp_new', NOW)).toBeNull()
    // The row still carries the old list — display as stale, docs §12.4.
    expect(catalogIsStale(env, 'fp_new', NOW)).toBe(true)
  })
})
