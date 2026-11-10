import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeConnection } from '../connections/types'
import { getCurrentPlatformTool } from '../tools/platform/current-domain-registry'
import { generateNativeAgentTurn } from './native-agent-tools'

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone() {
      return json(status, body)
    },
    body: null,
  } as unknown as Response
}

function connection(
  protocol: RuntimeConnection['protocol'],
  apiRoot: string,
): RuntimeConnection {
  return {
    id: 'connection-1',
    accountId: 'account-1',
    presetId: 'phase17-test',
    protocol,
    apiRoot: new URL(apiRoot),
    apiKey: 'phase17-secret-key',
    fingerprint: 'phase17-fingerprint',
    customEndpoint: false,
  }
}

const tool = getCurrentPlatformTool('services.get', 1)
if (!tool) throw new Error('services.get@1 missing from current platform registry')

afterEach(() => vi.unstubAllGlobals())

describe('native agent final-turn safety', () => {
  it('forces OpenAI-compatible providers into text-only mode when no tools are offered', () => {
    const source = readFileSync(new URL('./native-agent-tools.ts', import.meta.url), 'utf8')
    expect(source).toContain("tool_choice: tools.length ? 'auto' : 'none'")
    expect(source).toContain("input.tools.length === 0 && rawCalls.length > 0")
    expect(source).toContain("code: 'tool_call_not_allowed'")
  })
})

describe('OpenAI-compatible strict schema negotiation', () => {
  it('preserves the twelve real platform tool contracts while selecting strict per schema', async () => {
    const keys = [
      'coverage.check_availability',
      'coverage.find_offers',
      'coverage.get_rates',
      'coverage.propose_offer',
      'coverage.propose_request',
      'exchange_rates.get_current',
      'exchange_rates.record_trade_request',
      'intents.record',
      'pricing.calculate_quote',
      'services.get',
      'services.match_request',
      'services.search',
    ]
    const tools = keys.map((key) => {
      const manifest = getCurrentPlatformTool(key)
      if (!manifest) throw new Error('Missing platform tool: ' + key)
      return manifest
    })
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, { choices: [{ message: { content: 'OK', tool_calls: [] } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateNativeAgentTurn({
      connection: connection('openai', 'https://api.openai.com/v1/'),
      model: 'nvidia-compatible-fixture',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hello' }],
      tools,
    })).resolves.toMatchObject({ text: 'OK', toolCalls: [] })

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      tools: Array<{
        type: string
        function: {
          name: string
          strict: boolean
          parameters: { required?: string[]; properties?: Record<string, unknown> }
        }
      }>
      tool_choice: string
    }
    expect(payload.tools).toHaveLength(keys.length)
    expect(payload.tool_choice).toBe('auto')
    expect(payload.tools.every((entry) => entry.type === 'function')).toBe(true)
    const byName = new Map(payload.tools.map((entry) => [entry.function.name, entry.function]))
    expect(byName.get('wacrm__services__get')?.strict).toBe(true)
    expect(byName.get('wacrm__services__search')?.strict).toBe(false)
    expect(byName.get('wacrm__services__match_request')?.strict).toBe(false)
    expect(byName.get('wacrm__coverage__find_offers')?.strict).toBe(false)
    expect(byName.get('wacrm__services__search')?.parameters.required).toEqual([])
    expect(byName.get('wacrm__services__search')?.parameters.properties).toHaveProperty('query')
  })
})

describe('native provider matrix', () => {
  it('normalizes OpenAI-compatible native tool calls into the shared runtime contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json(200, {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call-openai-1',
                    type: 'function',
                    function: {
                      name: 'wacrm__services__get',
                      arguments: '{"id_or_code":"svc-1"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
        }),
      ),
    )

    await expect(
      generateNativeAgentTurn({
        connection: connection('openai', 'https://api.openai.com/v1/'),
        model: 'gpt-test',
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'show service' }],
        tools: [tool],
      }),
    ).resolves.toEqual({
      text: '',
      toolCalls: [
        {
          id: 'call-openai-1',
          toolKey: 'services.get',
          args: { id_or_code: 'svc-1' },
        },
      ],
      usage: { promptTokens: 9, completionTokens: 3, totalTokens: 12 },
    })
  })

  it('normalizes Anthropic native tool_use into the shared runtime contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json(200, {
          content: [
            {
              type: 'tool_use',
              id: 'toolu-anthropic-1',
              name: 'wacrm__services__get',
              input: { id_or_code: 'svc-2' },
            },
          ],
          usage: { input_tokens: 7, output_tokens: 2 },
        }),
      ),
    )

    await expect(
      generateNativeAgentTurn({
        connection: connection('anthropic', 'https://api.anthropic.com/v1/'),
        model: 'claude-test',
        systemPrompt: 'system',
        messages: [{ role: 'user', content: 'show service' }],
        tools: [tool],
      }),
    ).resolves.toEqual({
      text: '',
      toolCalls: [
        {
          id: 'toolu-anthropic-1',
          toolKey: 'services.get',
          args: { id_or_code: 'svc-2' },
        },
      ],
      usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
    })
  })

  it('normalizes Gemini native functionCall into the shared runtime contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json(200, {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'wacrm__services__get',
                      args: { id_or_code: 'svc-3' },
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 8,
            candidatesTokenCount: 4,
            totalTokenCount: 12,
          },
        }),
      ),
    )

    const result = await generateNativeAgentTurn({
      connection: connection(
        'gemini_native',
        'https://generativelanguage.googleapis.com/v1beta/',
      ),
      model: 'gemini-test',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'show service' }],
      tools: [tool],
    })

    expect(result.text).toBe('')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]).toMatchObject({
      toolKey: 'services.get',
      args: { id_or_code: 'svc-3' },
    })
    expect(result.toolCalls[0].id).toMatch(/^gemini:0:/)
    expect(result.usage).toEqual({
      promptTokens: 8,
      completionTokens: 4,
      totalTokens: 12,
    })
  })

  it.each([
    [
      'anthropic',
      'https://api.anthropic.com/v1/',
      {
        content: [
          {
            type: 'tool_use',
            id: 'unexpected',
            name: 'wacrm__services__get',
            input: {},
          },
        ],
      },
    ],
    [
      'gemini_native',
      'https://generativelanguage.googleapis.com/v1beta/',
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'wacrm__services__get',
                    args: {},
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  ] as const)(
    '%s fails closed if a provider invents a tool on a tool-free turn',
    async (protocol, apiRoot, body) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, body)))

      await expect(
        generateNativeAgentTurn({
          connection: connection(protocol, apiRoot),
          model: 'provider-test',
          systemPrompt: 'system',
          messages: [{ role: 'user', content: 'final answer only' }],
          tools: [],
        }),
      ).rejects.toMatchObject({ code: 'unknown_tool_call' })
    },
  )
})
