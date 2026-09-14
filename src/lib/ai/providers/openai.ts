import { AiError, type AiUsage } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  providerFetch,
  toNetworkError,
} from './shared'
import { joinApiPath } from '../outbound/url-join'
import { readBoundedJson, ResponseTooLargeError, ResponseMalformedError } from '../outbound/bounded-json'
import { normalizeOpenAiModels } from './normalize'
import type { ModelCatalog } from './model-types'
import type {
  AdapterContext,
  ProviderAdapter,
  ProviderEmbeddingInput,
  ProviderGenerateInput,
  ProviderResult,
} from './contract'

// ============================================================
// OpenAI-compatible adapter (documented subset).
//
// Supported: non-streaming Chat Completions + `GET models`. Anything
// beyond this subset (tools, streaming, images, assistants…) is NOT
// promised by compatibility. The API root comes from the server-
// validated connection (`ctx.apiRoot`) — a DeepSeek, OpenRouter or
// private-gateway connection reuses this adapter unchanged; preset
// additions never touch generate logic (ADR-001 acceptance).
// When no root is supplied the legacy public OpenAI default applies,
// keeping the old ai_configs path byte-identical.
// ============================================================

/** Root INCLUDING the version segment (Master §9.4). */
export const OPENAI_DEFAULT_ROOT = 'https://api.openai.com/v1/'

function chatCompletionsUrl(ctx: AdapterContext): string {
  return joinApiPath(ctx.apiRoot ?? OPENAI_DEFAULT_ROOT, 'chat/completions').toString()
}

function modelsUrl(ctx: AdapterContext): string {
  return joinApiPath(ctx.apiRoot ?? OPENAI_DEFAULT_ROOT, 'models').toString()
}

interface OpenAiResponse {
  choices?: {
    message?: { content?: string; reasoning_content?: string }
    finish_reason?: string
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateOpenAi(
  ctx: AdapterContext,
  input: ProviderGenerateInput,
): Promise<ProviderResult> {
  const { apiKey, timeoutMs } = ctx
  const { model, systemPrompt, messages } = input

  let res: Response
  try {
    res = await providerFetch(ctx, chatCompletionsUrl(ctx), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergeConsecutive(messages),
        ],
        max_completion_tokens: ctx.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
        ...(ctx.temperature != null ? { temperature: ctx.temperature } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null
  const first = data?.choices?.[0]
  const text = first?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    // Distinguish the two empty-response shapes (server log only):
    // a) reasoning model that spent the whole budget on
    //    reasoning_content before writing the answer (finish_reason
    //    'length') — fix by raising max_output_tokens / budget;
    // b) anything else — the raw body is the only clue.
    const budgetEaten =
      first?.finish_reason === 'length' &&
      typeof first?.message?.reasoning_content === 'string' &&
      first.message.reasoning_content.length > 0
    const headline = budgetEaten
      ? 'OpenAI returned an empty response: the reasoning model consumed the whole token budget on thinking (finish_reason=length). Raise the agent revision "max_output_tokens" (or pick a non-reasoning model).'
      : 'OpenAI returned an empty response.'
    const snippet = JSON.stringify(first ?? data ?? null).slice(0, 400)
    throw new AiError(`${headline} Endpoint said: ${snippet}`, {
      code: budgetEaten ? 'reasoning_truncated' : 'empty_response',
    })
  }
  const usage: AiUsage | null = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  })
  return { text, usage }
}

/**
 * Optional capability: list models from any OpenAI-compatible root.
 * A 404/405 here means "no discovery" — the caller records the
 * `model_discovery_unsupported` state and manual model entry keeps
 * working; it does NOT invalidate the connection (ADR-004, ADR-006).
 * The response is size-capped during streaming and structurally
 * validated before normalization.
 */
export async function listOpenAiCompatibleModels(
  ctx: AdapterContext,
): Promise<ModelCatalog> {
  let res: Response
  try {
    res = await providerFetch(ctx, modelsUrl(ctx), {
      method: 'GET',
      headers: { Authorization: `Bearer ${ctx.apiKey}` },
      signal: AbortSignal.timeout(ctx.timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (res.status === 404 || res.status === 405) {
    const err = new AiError(`${providerLabel(ctx)} does not support model discovery.`, {
      code: 'model_discovery_unsupported',
      status: 404,
    })
    throw err
  }
  if (!res.ok) {
    throw await providerHttpError('Model discovery', res)
  }

  let payload: { data?: unknown } | null
  try {
    payload = await readBoundedJson<{ data?: unknown }>(res)
  } catch (err) {
    if (err instanceof ResponseTooLargeError || err instanceof ResponseMalformedError) {
      throw new AiError('Model discovery returned an invalid response.', {
        code: 'ai_provider_malformed_response',
        status: 502,
      })
    }
    throw err
  }
  let catalog: ModelCatalog
  try {
    catalog = normalizeOpenAiModels(payload)
  } catch {
    throw new AiError('Model discovery returned an unexpected shape.', {
      code: 'ai_provider_malformed_response',
      status: 502,
    })
  }
  return catalog
}

function providerLabel(ctx: AdapterContext): string {
  return ctx.apiRoot ? 'The configured endpoint' : 'OpenAI'
}

// ---- embeddings (OpenAI-compatible shape) ----------------------

function embeddingsUrl(ctx: AdapterContext): string {
  return joinApiPath(ctx.apiRoot ?? OPENAI_DEFAULT_ROOT, 'embeddings').toString()
}

interface OpenAiEmbeddingsResponse {
  data?: { embedding?: unknown; index?: unknown }[]
}

/**
 * POST {root}embeddings with the documented non-streaming contract
 * (`model` + `input[]`). Ordering is restored from the response
 * `index` fields defensively — providers have shipped out-of-order
 * data in the past (docs §12.4). `dimensions` is NOT sent: the
 * connection stores an explicit observation instead (the caller's
 * 1536 gate validates whatever the model actually returns, which is
 * what official docs guarantee for text-embedding-3-small anyway).
 */
export async function embedOpenAiCompatible(
  ctx: AdapterContext,
  input: ProviderEmbeddingInput,
): Promise<number[][]> {
  if (input.inputs.length === 0) return []
  let res: Response
  try {
    res = await providerFetch(ctx, embeddingsUrl(ctx), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: input.model, input: input.inputs }),
      signal: AbortSignal.timeout(ctx.timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }
  if (res.status === 404 || res.status === 405) {
    throw new AiError(`${providerLabel(ctx)} does not support embeddings.`, {
      code: 'ai_unsupported_capability',
      status: 400,
    })
  }
  if (!res.ok) throw await providerHttpError('Embeddings', res)

  let payload: OpenAiEmbeddingsResponse | null
  try {
    payload = await readBoundedJson<OpenAiEmbeddingsResponse>(res)
  } catch {
    throw new AiError('Embeddings response was malformed.', { code: 'embeddings_malformed' })
  }
  if (!Array.isArray(payload?.data)) {
    throw new AiError('Embeddings response missing a vector.', { code: 'embeddings_malformed' })
  }
  const rows = payload!.data.map((item, position) => {
    const values = item?.embedding
    if (!Array.isArray(values)) {
      throw new AiError('Embeddings response missing a vector.', { code: 'embeddings_malformed' })
    }
    const index =
      typeof item.index === 'number' && Number.isInteger(item.index) ? item.index : position
    return { index, values }
  })
  if (new Set(rows.map((r) => r.index)).size !== rows.length) {
    throw new AiError('Embeddings response had the wrong number of vectors.', {
      code: 'embeddings_malformed',
    })
  }
  return rows.sort((a, b) => a.index - b.index).map((r) => r.values as number[])
}

/**
 * Adapter registration object. Shared verbatim by all OpenAI-compatible
 * presets (OpenAI fixed root, DeepSeek fixed root, custom gateways) —
 * adding a preset never changes generate logic.
 */
export const openaiAdapter: ProviderAdapter = {
  protocol: 'openai',
  generate: generateOpenAi,
  listModels: listOpenAiCompatibleModels,
  embed: embedOpenAiCompatible,
}
