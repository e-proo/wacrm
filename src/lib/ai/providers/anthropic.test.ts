import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateAnthropic, listAnthropicModels } from './anthropic'
import type { ProviderGenerateInput } from './contract'

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

const baseCtx = { apiKey: 'sk-ant-test', timeoutMs: 5000 }
const genInput: ProviderGenerateInput = {
  model: 'claude-x',
  systemPrompt: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
}

afterEach(() => vi.unstubAllGlobals())

describe('generateAnthropic — regression (behavior must match Phase 01)', () => {
  it('same URL, headers, alternating-role normalization and usage summation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, { content: [{ type: 'text', text: 'Hi!' }], usage: { input_tokens: 7, output_tokens: 3 } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const res = await generateAnthropic(baseCtx, genInput)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(opts.headers['x-api-key']).toBe('sk-ant-test')
    expect(opts.headers['anthropic-version']).toBe('2023-06-01')
    expect(res.usage).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 })
  })

  it('merges consecutive same-role messages and drops leading assistant turns', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { content: [{ type: 'text', text: 'ok' }] }))
    vi.stubGlobal('fetch', fetchMock)
    await generateAnthropic(baseCtx, {
      model: 'm',
      systemPrompt: 's',
      messages: [
        { role: 'assistant', content: 'A1' },
        { role: 'assistant', content: 'A2' },
        { role: 'user', content: 'U1' },
        { role: 'user', content: 'U2' },
        { role: 'assistant', content: 'A3' },
        { role: 'user', content: 'U3' },
      ],
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('401 maps to invalid_key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(401, { error: { message: 'bad' } })))
    await expect(generateAnthropic(baseCtx, genInput)).rejects.toMatchObject({ code: 'invalid_key' })
  })
})

describe('listAnthropicModels — official cursor pagination, bounded', () => {
  it('single complete page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, {
      data: [{ id: 'claude-b', display_name: 'Claude B', type: 'model' }],
      has_more: false,
      first_id: 'claude-b',
      last_id: 'claude-b',
    }))
    vi.stubGlobal('fetch', fetchMock)
    const cat = await listAnthropicModels(baseCtx)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/models?limit=100')
    expect(cat.models[0]).toMatchObject({ id: 'claude-b', displayName: 'Claude B', capabilities: { chat: 'supported', embeddings: 'unknown' } })
    expect(cat.completeness).toBe('complete')
  })

  it('follows has_more+last_id with `after` query param, stops on final page', async () => {
    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce(json(200, {
        data: [{ id: 'a1', type: 'model' }], has_more: true, last_id: 'a1',
      }))
      .mockResolvedValueOnce(json(200, {
        data: [{ id: 'a2', type: 'model' }], has_more: true, last_id: 'a2',
      }))
      .mockResolvedValueOnce(json(200, {
        data: [{ id: 'a3', type: 'model' }], has_more: false,
      }))
    vi.stubGlobal('fetch', fetchMock)
    const cat = await listAnthropicModels(baseCtx)
    expect(cat.models.map((m) => m.id)).toEqual(['a1', 'a2', 'a3'])
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.anthropic.com/v1/models?limit=100&after=a1')
    expect(fetchMock.mock.calls[2][0]).toBe('https://api.anthropic.com/v1/models?limit=100&after=a2')
  })

  it('a gateway WITHOUT has_more/last_id fields still returns one page (no crash, no assumption)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, {
      data: [{ id: 'x1' }], // no type either → chat unknown, not unsupported
    })))
    const cat = await listAnthropicModels(baseCtx)
    expect(cat.models).toHaveLength(1)
    expect(cat.models[0].capabilities.chat).toBe('unknown')
    expect(cat.models[0].capabilities.embeddings).toBe('unknown')
  })

  it('respects the page cap', async () => {
    const fetchMock = vi.fn()
    for (let i = 0; i < 8; i++) {
      fetchMock.mockResolvedValueOnce(json(200, {
        data: Array.from({ length: 100 }, (_, j) => ({ id: `p${i}m${j}`, type: 'model' })),
        has_more: true,
        last_id: `p${i}m99`,
      }))
    }
    vi.stubGlobal('fetch', fetchMock)
    const cat = await listAnthropicModels(baseCtx)
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(cat.completeness).toBe('bounded')
  })

  it('sends the version header on list calls', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await listAnthropicModels(baseCtx)
    expect(fetchMock.mock.calls[0][1].headers['anthropic-version']).toBeTruthy()
  })
})
