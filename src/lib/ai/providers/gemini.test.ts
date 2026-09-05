import { describe, it, expect, vi, afterEach } from 'vitest'
import { AiError } from '../types'
import { generateGemini, listGeminiModels, embedGemini, normalizeGeminiId, GEMINI_DEFAULT_ROOT } from './gemini'

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: null,
  } as unknown as Response
}

const KEY = 'secret-key-DO-NOT-LEAK'
const baseCtx = { apiKey: KEY, timeoutMs: 5000 }

afterEach(() => vi.unstubAllGlobals())

describe('normalizeGeminiId', () => {
  it('strips the models/ prefix once and never double-prefixes', () => {
    expect(normalizeGeminiId('models/gemini-2.5-flash')).toBe('gemini-2.5-flash')
    expect(normalizeGeminiId('gemini-2.5-flash')).toBe('gemini-2.5-flash')
    expect(normalizeGeminiId('  models/x  ')).toBe('x')
  })
})

describe('generateGemini', () => {
  it('posts to the official :generateContent path with header auth and no key in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, {
        candidates: [{ content: { parts: [{ text: 'Hello!' }], role: 'model' }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const res = await generateGemini(
      { ...baseCtx, apiRoot: new URL('https://generativelanguage.googleapis.com/v1beta/') },
      { model: 'gemini-2.5-flash', systemPrompt: 'sys', messages: [{ role: 'assistant', content: 'prev' }, { role: 'user', content: 'hi' }] },
    )
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent')
    expect(url).not.toContain(KEY) // key must never appear in the URL
    expect(opts.headers['x-goog-api-key']).toBe(KEY)
    const body = JSON.parse(opts.body)
    expect(body.systemInstruction.parts[0].text).toBe('sys')
    // assistant → model, user → user (native role naming)
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(['model', 'user'])
    expect(res).toEqual({
      text: 'Hello!',
      handoff: undefined,
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    })
  })

  it('accepts a raw models/... id without double-prefixing the path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, { candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' }] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await generateGemini(baseCtx, { model: 'models/gemini-x', systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }] })
    expect(fetchMock.mock.calls[0][0]).toBe(`${GEMINI_DEFAULT_ROOT}models/gemini-x:generateContent`)
    expect(fetchMock.mock.calls[0][0]).not.toContain('models/models/')
  })

  it('treats a SAFETY finishReason as blocked_by_provider, not empty text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      json(200, { candidates: [{ finishReason: 'SAFETY' }] }),
    ))
    await expect(
      generateGemini(baseCtx, { model: 'm', systemPrompt: 's', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ code: 'blocked_by_provider' })
  })

  it('respects promptFeedback.blockReason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      json(200, { promptFeedback: { blockReason: 'BLOCKLIST' } }),
    ))
    await expect(
      generateGemini(baseCtx, { model: 'm', systemPrompt: 's', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ code: 'blocked_by_provider' })
  })

  it('empty parts → empty_response AiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      json(200, { candidates: [{ content: { parts: [] } }] }),
    ))
    await expect(
      generateGemini(baseCtx, { model: 'm', systemPrompt: 's', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toBeInstanceOf(AiError)
  })

  it('maps 403 to invalid_key and never echoes the key in the message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(403, { error: { message: 'permission denied' } })))
    try {
      await generateGemini(baseCtx, { model: 'm', systemPrompt: 's', messages: [{ role: 'user', content: 'x' }] })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(AiError)
      expect((err as AiError).code).toBe('invalid_key')
      expect((err as AiError).message).not.toContain(KEY)
    }
  })
})

describe('listGeminiModels — native list + pageToken', () => {
  it('follows nextPageToken and stops with complete=false only past caps', async () => {
    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce(json(200, {
        models: [
          { name: 'models/gemini-a', displayName: 'A', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'], inputTokenLimit: 1e6 },
          { name: 'models/embed-me', supportedGenerationMethods: ['embedContent'] },
        ],
        nextPageToken: 'PAGE2',
      }))
      .mockResolvedValueOnce(json(200, {
        models: [{ name: 'models/gemini-b', supportedGenerationMethods: ['generateContent', 'embedContent'] }],
      }))
    vi.stubGlobal('fetch', fetchMock)

    const cat = await listGeminiModels(baseCtx)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toContain('pageToken=PAGE2')
    // sorted bare ids; models/ prefix stripped; rawProviderId preserved
    expect(cat.models.map((m) => m.id)).toEqual(['embed-me', 'gemini-a', 'gemini-b'])
    expect(cat.models.find((m) => m.id === 'embed-me')?.rawProviderId).toBe('models/embed-me')
    // capabilities from official methods, not names:
    const a = cat.models.find((m) => m.id === 'gemini-a')!
    expect(a.capabilities.chat).toBe('supported')
    expect(a.capabilities.embeddings).toBe('unsupported')
    const e = cat.models.find((m) => m.id === 'embed-me')!
    expect(e.capabilities.chat).toBe('unsupported')
    expect(e.capabilities.embeddings).toBe('supported')
    expect(cat.completeness).toBe('complete')
  })

  it('absent supportedGenerationMethods metadata → unknown (custom gateway, ADR-005)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { models: [{ name: 'mystery' }] })))
    const cat = await listGeminiModels(baseCtx)
    expect(cat.models[0].capabilities.chat).toBe('unknown')
  })

  it('stops at the page cap and reports bounded completeness', async () => {
    const fetchMock = vi.fn()
    for (let i = 0; i < 8; i++) {
      fetchMock.mockResolvedValueOnce(json(200, {
        models: Array.from({ length: 100 }, (_, j) => ({ name: `m/p${i}-${j}` })),
        nextPageToken: `T${i}`,
      }))
    }
    vi.stubGlobal('fetch', fetchMock)
    const cat = await listGeminiModels(baseCtx)
    expect(fetchMock).toHaveBeenCalledTimes(5) // max pages
    expect(cat.completeness).toBe('bounded')
  })
})

describe('embedGemini (seam only)', () => {
  it('returns vectors in input order and rejects non-finite values', async () => {
    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce(json(200, { embedding: { values: [0.1, 0.2] } }))
      .mockResolvedValueOnce(json(200, { embedding: { values: [NaN, 0.5] } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      embedGemini(baseCtx, { model: 'embed-001', inputs: ['a', 'b'] }),
    ).rejects.toMatchObject({ code: 'embeddings_malformed' })
  })
})
