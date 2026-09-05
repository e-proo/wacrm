import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateOpenAi, listOpenAiCompatibleModels, OPENAI_DEFAULT_ROOT } from './openai'
import { AiError } from '../types'

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: null,
  } as unknown as Response
}

afterEach(() => vi.unstubAllGlobals())

describe('generateOpenAi — api root sourcing (FR-02.1)', () => {
  it('defaults to the public OpenAI root when no connection root is given (legacy path)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await generateOpenAi(
      { apiKey: 'k', timeoutMs: 1000 },
      { model: 'm', systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }] },
    )
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions')
    expect(OPENAI_DEFAULT_ROOT).toBe('https://api.openai.com/v1/')
  })

  it('DeepSeek-like compatible root flows through the SAME code path — no brand branch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await generateOpenAi(
      { apiKey: 'k', timeoutMs: 1000, apiRoot: new URL('https://api.deepseek.com/') },
      { model: 'deepseek-chat', systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }] },
    )
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions')
  })

  it('empty-but-valid list is a normal catalog, not a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { data: [] })))
    const cat = await listOpenAiCompatibleModels({
      apiKey: 'k',
      timeoutMs: 5000,
      apiRoot: new URL('https://api.openai.com/v1/'),
    })
    expect(cat.models).toEqual([])
    expect(cat.completeness).toBe('complete')
    // An empty list must NOT be treated as a failure — manual entry stays.
  })

  it('missing data array surfaces as a malformed-list error, never a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { models: ['not-a-data-array'] })),
    )
    await expect(
      listOpenAiCompatibleModels({
        apiKey: 'k',
        timeoutMs: 5000,
        apiRoot: new URL('https://api.openai.com/v1/'),
      }),
    ).rejects.toBeInstanceOf(AiError)
  })
})

describe('listOpenAiCompatibleModels', () => {
  it('normalizes a standard payload joined onto the connection root', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { data: [{ id: 'deepseek-chat', owned_by: 'deepseek' }] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const cat = await listOpenAiCompatibleModels({
      apiKey: 'k',
      timeoutMs: 5000,
      apiRoot: new URL('https://api.deepseek.com/'),
    })
    // Relative join against version-less root: /models (DeepSeek's
    // documented OpenAI-compatible list endpoint).
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/models')
    expect(fetchMock.mock.calls[0][1].method).toBe('GET')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer k')
    expect(cat.models[0].id).toBe('deepseek-chat')
    // Capabilities unknown from a bare OpenAI-style list (rule §4:
    // heuristics must never hard-block).
    expect(cat.models[0].capabilities.embeddings).toBe('unknown')
  })

  it('404 → model_discovery_unsupported (connection stays usable, manual entry only)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { error: 'nope' })))
    await expect(
      listOpenAiCompatibleModels({ apiKey: 'k', timeoutMs: 5000, apiRoot: new URL('https://gw.example/v1/') }),
    ).rejects.toMatchObject({ code: 'model_discovery_unsupported', status: 404 })
  })

  it('401 maps to invalid_key via the shared provider error path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(401, { error: { message: 'bad key' } })),
    )
    await expect(
      listOpenAiCompatibleModels({ apiKey: 'k', timeoutMs: 5000, apiRoot: new URL('https://api.openai.com/v1/') }),
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 })
  })

  it('non-JSON body → ai_provider_malformed_response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: (function () {
          const chunks = [new TextEncoder().encode('<html>not json</html>')]
          let i = 0
          return {
            getReader: () => ({
              read: async () =>
                i < chunks.length ? { done: false, value: chunks[i++] } : { done: true },
              releaseLock: () => {},
              cancel: async () => {},
            }),
          }
        })(),
      } as unknown as Response),
    )
    await expect(
      listOpenAiCompatibleModels({ apiKey: 'k', timeoutMs: 5000, apiRoot: new URL('https://api.openai.com/v1/') }),
    ).rejects.toMatchObject({ code: 'ai_provider_malformed_response' })
  })

  it('declared content-length over the cap → malformed_response (no giant allocation)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {}, { 'content-length': String(10 * 1024 * 1024) }),
      ),
    )
    await expect(
      listOpenAiCompatibleModels({ apiKey: 'k', timeoutMs: 5000, apiRoot: new URL('https://api.openai.com/v1/') }),
    ).rejects.toMatchObject({ code: 'ai_provider_malformed_response' })
  })
})
