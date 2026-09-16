import { AiError, type AiUsage } from '@/lib/ai/types'
import type { RuntimeConnection } from '@/lib/ai/connections/types'
import type { ToolDefinition } from './tool-registry'
import { toJsonSchema } from './tool-schema'
import { providerFetch, providerHttpError, normalizeUsage, toNetworkError } from '@/lib/ai/providers/shared'
import { joinApiPath } from '@/lib/ai/outbound/url-join'
import { aiRequestTimeoutMs, MAX_OUTPUT_TOKENS } from '@/lib/ai/defaults'
import { getCurrentPlatformTool } from '../tools/platform/current-domain-registry'
import { renderToolUsageDescription } from '../tools/platform/contracts'

export interface NativeToolCall {
  id: string
  toolKey: string
  args: Record<string, unknown>
}

export type NativeAgentMessage =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'assistant_tool'; content: string; calls: NativeToolCall[] }
  | { role: 'tool'; callId: string; toolKey: string; content: string }

export interface NativeAgentResult {
  text: string
  toolCalls: NativeToolCall[]
  usage: AiUsage | null
}

export interface NativeAgentGenerateInput {
  connection: RuntimeConnection
  model: string
  systemPrompt: string
  messages: NativeAgentMessage[]
  tools: ReadonlyArray<ToolDefinition>
  maxOutputTokens?: number | null
  temperature?: number | null
}

/**
 * Native structured-tool generation for the multi-agent runtime only.
 * There is deliberately NO text/regex fallback: if the configured endpoint
 * does not implement the provider's native tool protocol, the run fails
 * closed instead of interpreting model prose as executable JSON.
 */
export async function generateNativeAgentTurn(
  input: NativeAgentGenerateInput,
): Promise<NativeAgentResult> {
  switch (input.connection.protocol) {
    case 'openai': return generateOpenAi(input)
    case 'anthropic': return generateAnthropic(input)
    case 'gemini_native': return generateGemini(input)
    default: {
      const exhaustive: never = input.connection.protocol
      throw new AiError(`Unsupported native-tool protocol: ${String(exhaustive)}`, {
        code: 'native_tools_unsupported', status: 400,
      })
    }
  }
}

function providerName(toolKey: string): string {
  // OpenAI-compatible names are intentionally conservative: letters,
  // numbers, underscore and dash. Mapping is reversible only through the
  // exact registry supplied to the request, never by trusting arbitrary text.
  return `wacrm__${toolKey.replace(/[^A-Za-z0-9_-]/g, '__')}`
}

function keyByProviderName(tools: ReadonlyArray<ToolDefinition>): Map<string, string> {
  return new Map(tools.map((tool) => [providerName(tool.key), tool.key]))
}

function toolPayloads(tools: ReadonlyArray<ToolDefinition>) {
  return tools.map((tool) => {
    const manifest = getCurrentPlatformTool(tool.key, tool.version)
    if (!manifest) {
      throw new AiError(`Tool ${tool.key}@${tool.version} has no platform manifest.`, {
        code: 'tool_contract_missing', status: 500,
      })
    }
    return {
      key: tool.key,
      name: providerName(tool.key),
      // Provider-facing descriptions are generated from the same contract
      // the runtime authorizes, so "when to use" cannot drift from policy.
      description: renderToolUsageDescription(manifest),
      schema: toJsonSchema(tool),
    }
  })
}

function parseArgs(raw: unknown, toolKey: string): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') throw malformedToolArgs(toolKey)
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object')
    return parsed as Record<string, unknown>
  } catch {
    throw malformedToolArgs(toolKey)
  }
}

function malformedToolArgs(toolKey: string) {
  return new AiError(`Provider returned malformed arguments for tool ${toolKey}.`, {
    code: 'malformed_tool_call', status: 502,
  })
}

function timeoutMs(): number { return aiRequestTimeoutMs() }

// ---------------------------------------------------------------------------
// OpenAI Chat Completions native functions
// ---------------------------------------------------------------------------
async function generateOpenAi(input: NativeAgentGenerateInput): Promise<NativeAgentResult> {
  const map = keyByProviderName(input.tools)
  const tools = toolPayloads(input.tools)
  const messages = [
    { role: 'system', content: input.systemPrompt },
    ...input.messages.map((m) => {
      if (m.role === 'assistant_tool') {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: providerName(c.toolKey), arguments: JSON.stringify(c.args) },
          })),
        }
      }
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.callId, content: m.content }
      }
      return { role: m.role, content: m.content }
    }),
  ]

  let res: Response
  try {
    res = await providerFetch(
      {
        apiKey: input.connection.apiKey,
        timeoutMs: timeoutMs(),
        apiRoot: input.connection.apiRoot,
        customEndpoint: input.connection.customEndpoint,
      },
      joinApiPath(input.connection.apiRoot, 'chat/completions').toString(),
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${input.connection.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: input.model,
          messages,
          tools: tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.schema, strict: true },
          })),
          // Some OpenAI-compatible providers keep trying to call a function
          // after a tool-result turn even when the next request supplies an
          // empty tool list. Be explicit: final/recovery turns are text-only.
          tool_choice: tools.length ? 'auto' : 'none',
          max_completion_tokens: input.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
          ...(input.temperature != null ? { temperature: input.temperature } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs()),
      },
    )
  } catch (err) { throw toNetworkError(err) }
  if (!res.ok) throw await providerHttpError('OpenAI native tools', res)

  const data = await res.json().catch(() => null) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  } | null
  const msg = data?.choices?.[0]?.message
  const text = typeof msg?.content === 'string' ? msg.content.trim() : ''
  const rawCalls = msg?.tool_calls ?? []

  // A tool call is never executable when this turn intentionally offered no
  // tools. Do not reinterpret it against stale names from earlier rounds.
  // If the provider also supplied text, keep the text and discard the
  // protocol violation; otherwise fail closed with a precise provider error.
  if (input.tools.length === 0 && rawCalls.length > 0) {
    console.warn('[agent native] provider returned a tool call during a tool-free OpenAI turn')
    if (text) {
      return {
        text,
        toolCalls: [],
        usage: normalizeUsage({
          prompt: data?.usage?.prompt_tokens,
          completion: data?.usage?.completion_tokens,
          total: data?.usage?.total_tokens,
        }),
      }
    }
    throw new AiError('Provider returned a native tool during a tool-free turn.', {
      code: 'tool_call_not_allowed',
      status: 502,
    })
  }

  const calls: NativeToolCall[] = []
  for (const raw of rawCalls) {
    const key = raw.function?.name ? map.get(raw.function.name) : undefined
    if (!key || !raw.id) throw new AiError('Provider returned an unknown native tool.', { code: 'unknown_tool_call', status: 502 })
    calls.push({ id: raw.id, toolKey: key, args: parseArgs(raw.function?.arguments, key) })
  }
  if (!text && calls.length === 0) throw new AiError('OpenAI returned an empty response.', { code: 'empty_response' })
  return {
    text,
    toolCalls: calls,
    usage: normalizeUsage({
      prompt: data?.usage?.prompt_tokens,
      completion: data?.usage?.completion_tokens,
      total: data?.usage?.total_tokens,
    }),
  }
}

// ---------------------------------------------------------------------------
// Anthropic Messages native tool_use/tool_result
// ---------------------------------------------------------------------------
async function generateAnthropic(input: NativeAgentGenerateInput): Promise<NativeAgentResult> {
  const map = keyByProviderName(input.tools)
  const tools = toolPayloads(input.tools)
  // Anthropic expects all tool results for one assistant turn in a SINGLE
  // following user message. The runtime stores one internal message per tool
  // result, so fold adjacent results together instead of emitting consecutive
  // user turns (which the Messages API rejects).
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
  for (const m of input.messages) {
    if (m.role === 'assistant_tool') {
      messages.push({
        role: 'assistant',
        content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.calls.map((c) => ({ type: 'tool_use', id: c.id, name: providerName(c.toolKey), input: c.args })),
        ],
      })
      continue
    }
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.callId, content: m.content }
      const last = messages[messages.length - 1]
      if (last?.role === 'user' && Array.isArray(last.content)) {
        ;(last.content as unknown[]).push(block)
      } else {
        messages.push({ role: 'user', content: [block] })
      }
      continue
    }
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })
  }

  let res: Response
  try {
    res = await providerFetch(
      {
        apiKey: input.connection.apiKey,
        timeoutMs: timeoutMs(),
        apiRoot: input.connection.apiRoot,
        customEndpoint: input.connection.customEndpoint,
      },
      joinApiPath(input.connection.apiRoot, 'messages').toString(),
      {
        method: 'POST',
        headers: {
          'x-api-key': input.connection.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: input.model,
          system: input.systemPrompt,
          max_tokens: input.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
          ...(input.temperature != null ? { temperature: Math.min(input.temperature, 1) } : {}),
          messages,
          tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
        }),
        signal: AbortSignal.timeout(timeoutMs()),
      },
    )
  } catch (err) { throw toNetworkError(err) }
  if (!res.ok) throw await providerHttpError('Anthropic native tools', res)

  const data = await res.json().catch(() => null) as {
    content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>
    usage?: { input_tokens?: number; output_tokens?: number }
  } | null
  const text = (data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim()
  const calls: NativeToolCall[] = []
  for (const block of data?.content ?? []) {
    if (block.type !== 'tool_use') continue
    const key = block.name ? map.get(block.name) : undefined
    if (!key || !block.id) throw new AiError('Anthropic returned an unknown native tool.', { code: 'unknown_tool_call', status: 502 })
    calls.push({ id: block.id, toolKey: key, args: parseArgs(block.input, key) })
  }
  if (!text && calls.length === 0) throw new AiError('Anthropic returned an empty response.', { code: 'empty_response' })
  return {
    text,
    toolCalls: calls,
    usage: normalizeUsage({ prompt: data?.usage?.input_tokens, completion: data?.usage?.output_tokens }),
  }
}

// ---------------------------------------------------------------------------
// Gemini native functionDeclarations/functionCall/functionResponse
// ---------------------------------------------------------------------------
async function generateGemini(input: NativeAgentGenerateInput): Promise<NativeAgentResult> {
  const map = keyByProviderName(input.tools)
  const tools = toolPayloads(input.tools)
  const bareModel = input.model.startsWith('models/') ? input.model.slice('models/'.length) : input.model
  if (!bareModel) throw new AiError('Gemini model id is empty.', { code: 'invalid_request', status: 400 })

  // Gemini likewise accepts multiple functionResponse parts in the user turn
  // that follows a model functionCall turn. Group adjacent results so one
  // multi-tool round preserves the provider's native conversation shape.
  const contents: Array<{ role: 'user' | 'model'; parts: unknown[] }> = []
  for (const m of input.messages) {
    if (m.role === 'assistant_tool') {
      contents.push({
        role: 'model',
        parts: [
          ...(m.content ? [{ text: m.content }] : []),
          ...m.calls.map((c) => ({ functionCall: { name: providerName(c.toolKey), args: c.args } })),
        ],
      })
      continue
    }
    if (m.role === 'tool') {
      const part = {
        functionResponse: {
          name: providerName(m.toolKey),
          response: { result: safeJson(m.content) },
        },
      }
      const last = contents[contents.length - 1]
      if (last?.role === 'user' && last.parts.every((p) => 'functionResponse' in (p as Record<string, unknown>))) {
        last.parts.push(part)
      } else {
        contents.push({ role: 'user', parts: [part] })
      }
      continue
    }
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })
  }

  let res: Response
  try {
    res = await providerFetch(
      {
        apiKey: input.connection.apiKey,
        timeoutMs: timeoutMs(),
        apiRoot: input.connection.apiRoot,
        customEndpoint: input.connection.customEndpoint,
      },
      joinApiPath(input.connection.apiRoot, `models/${bareModel}:generateContent`).toString(),
      {
        method: 'POST',
        headers: { 'x-goog-api-key': input.connection.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: input.systemPrompt }] },
          contents,
          tools: tools.length ? [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.schema })) }] : undefined,
          generationConfig: {
            maxOutputTokens: input.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
            ...(input.temperature != null ? { temperature: input.temperature } : {}),
          },
        }),
        signal: AbortSignal.timeout(timeoutMs()),
      },
    )
  } catch (err) { throw toNetworkError(err) }
  if (!res.ok) throw await providerHttpError('Gemini native tools', res)

  const data = await res.json().catch(() => null) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }> } }>
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
    promptFeedback?: { blockReason?: string }
  } | null
  if (data?.promptFeedback?.blockReason) throw new AiError('Gemini blocked the request by policy.', { code: 'blocked_by_provider', status: 502 })
  const parts = data?.candidates?.[0]?.content?.parts ?? []
  const text = parts.map((p) => p.text ?? '').join('').trim()
  const calls: NativeToolCall[] = []
  let i = 0
  for (const part of parts) {
    const fc = part.functionCall
    if (!fc) continue
    const key = fc.name ? map.get(fc.name) : undefined
    if (!key) throw new AiError('Gemini returned an unknown native tool.', { code: 'unknown_tool_call', status: 502 })
    calls.push({ id: `gemini:${i++}:${fc.name}`, toolKey: key, args: parseArgs(fc.args, key) })
  }
  if (!text && calls.length === 0) throw new AiError('Gemini returned an empty response.', { code: 'empty_response' })
  return {
    text,
    toolCalls: calls,
    usage: normalizeUsage({
      prompt: data?.usageMetadata?.promptTokenCount,
      completion: data?.usageMetadata?.candidatesTokenCount,
      total: data?.usageMetadata?.totalTokenCount,
    }),
  }
}

function safeJson(content: string): unknown {
  try { return JSON.parse(content) as unknown } catch { return { text: content } }
}
