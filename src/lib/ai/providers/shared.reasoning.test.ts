import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { providerFetch, resetReasoningCapabilityCacheForTests } from './shared'

const ctx = {
  apiKey: 'test-key',
  timeoutMs: 1000,
  apiRoot: new URL('https://example.test/v1/'),
  customEndpoint: false,
}

function request(model = 'provider/reasoning-model') {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  }
}

function bodyAt(fetchMock: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

describe('OpenAI-compatible reasoning effort negotiation', () => {
  beforeEach(() => {
    resetReasoningCapabilityCacheForTests()
    vi.stubEnv('AI_REASONING_EFFORT', 'auto')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    resetReasoningCapabilityCacheForTests()
  })

  it('adds low reasoning effort when the model accepts it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await providerFetch(
      ctx,
      'https://example.test/v1/chat/completions',
      request(),
    )

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(bodyAt(fetchMock, 0).reasoning_effort).toBe('low')
  })

  it('retries once without reasoning effort when the provider explicitly rejects the field', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'reasoning_effort is not supported for this model' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const res = await providerFetch(
      ctx,
      'https://example.test/v1/chat/completions',
      request('provider/plain-model'),
    )

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodyAt(fetchMock, 0).reasoning_effort).toBe('low')
    expect(bodyAt(fetchMock, 1)).not.toHaveProperty('reasoning_effort')

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await providerFetch(
      ctx,
      'https://example.test/v1/chat/completions',
      request('provider/plain-model'),
    )

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(bodyAt(fetchMock, 2)).not.toHaveProperty('reasoning_effort')
  })

  it('does not retry unrelated provider errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'invalid tool schema' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await providerFetch(
      ctx,
      'https://example.test/v1/chat/completions',
      request(),
    )

    expect(res.status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('can be disabled globally without changing provider requests', async () => {
    vi.stubEnv('AI_REASONING_EFFORT', 'off')
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await providerFetch(
      ctx,
      'https://example.test/v1/chat/completions',
      request(),
    )

    expect(bodyAt(fetchMock, 0)).not.toHaveProperty('reasoning_effort')
  })
})
