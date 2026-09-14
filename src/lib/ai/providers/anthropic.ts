import { AiError, type AiUsage, type ChatMessage } from '../types'
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
import { normalizeAnthropicModels } from './normalize'
import type { ModelCatalog } from './model-types'
import type {
  AdapterContext,
  ProviderAdapter,
  ProviderGenerateInput,
  ProviderResult,
} from './contract'

// ============================================================
// Anthropic adapter — Messages API + official /v1/models list.
// Generation behavior is byte-for-byte the Phase 01 legacy path when
// no apiRoot is supplied (the fixed public preset). With a connection
// apiRoot it joins the same relative path — no client can shape it.
// ============================================================

/** Root INCLUDING the version segment. */
export const ANTHROPIC_DEFAULT_ROOT = 'https://api.anthropic.com/v1/'
const ANTHROPIC_VERSION = '2023-06-01' // server-defined, never a client input

function messagesUrl(ctx: AdapterContext): string {
  return joinApiPath(ctx.apiRoot ?? ANTHROPIC_DEFAULT_ROOT, 'messages').toString()
}

function modelsUrlFor(ctx: AdapterContext, after: string): string {
  const base = joinApiPath(ctx.apiRoot ?? ANTHROPIC_DEFAULT_ROOT, 'models')
  const params = new URLSearchParams({ limit: String(ANTHROPIC_PAGE_SIZE) })
  if (after) params.set('after', after)
  return `${base.toString()}?${params.toString()}`
}

interface AnthropicResponse {
  content?: { type?: string; text?: string }[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

/**
 * Anthropic's Messages API requires strictly alternating roles that
 * begin with `user`. Merge consecutive turns, then drop any leading
 * assistant turns (an agent greeting before the customer said anything)
 * so the transcript always starts on the customer. Guarantees a valid,
 * non-empty payload.
 */
function normalizeForAnthropic(messages: ChatMessage[]): ChatMessage[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  if (merged.length === 0) {
    return [{ role: 'user', content: '(The customer has not sent a message yet.)' }]
  }
  return merged
}

/**
 * Call Anthropic's Messages endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateAnthropic(
  ctx: AdapterContext,
  input: ProviderGenerateInput,
): Promise<ProviderResult> {
  const { apiKey, timeoutMs } = ctx
  const { model, systemPrompt, messages } = input

  let res: Response
  try {
    res = await providerFetch(ctx, messagesUrl(ctx), {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        max_tokens: ctx.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
        // Anthropic only accepts 0-1; the revision knob is stored
        // 0-2 for all providers, so clamp rather than 400 at runtime.
        ...(ctx.temperature != null
          ? { temperature: Math.min(ctx.temperature, 1) }
          : {}),
        messages: normalizeForAnthropic(messages),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res)
  }

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null
  const text = data?.content
    ?.filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
  if (!text) {
    throw new AiError('Anthropic returned an empty response.', {
      code: 'empty_response',
    })
  }
  // Anthropic reports input/output but no total — normalizeUsage sums.
  const usage: AiUsage | null = normalizeUsage({
    prompt: data?.usage?.input_tokens,
    completion: data?.usage?.output_tokens,
  })
  return { text, usage }
}

// ---- official /v1/models with cursor pagination ----------------
// Contract: GET {root}models[?after=<id>] → { data:[{id,display_name,
// type}], has_more, first_id, last_id }. Verified live on 2026-09-04
// (unauthenticated GET /v1/models responds 403 from api.anthropic.com,
// confirming path existence); field-level schema from docs.anthropic.
// com is listed as a human re-verify item in the Phase 04 report
// (docs site was region-blocked from the build environment).
// Not every Anthropic-compatible gateway carries `has_more`/`last_id`:
// absent fields end pagination with whatever data we hold (Master §12.2)
// — never a crash and never an assumption of the newest fields.

const ANTHROPIC_PAGE_SIZE = 100
const ANTHROPIC_MAX_PAGES = 5

interface RawAnthropicModelsResponse {
  data?: unknown[]
  has_more?: unknown
  last_id?: unknown
}

export async function listAnthropicModels(ctx: AdapterContext): Promise<ModelCatalog> {
  const pages: { data?: unknown[] }[] = []
  let after = ''
  let morePending = false
  for (let pageNo = 0; pageNo < ANTHROPIC_MAX_PAGES; pageNo++) {
    let res: Response
    try {
      res = await providerFetch(ctx, modelsUrlFor(ctx, after), {
        method: 'GET',
        headers: {
          'x-api-key': ctx.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        signal: AbortSignal.timeout(ctx.timeoutMs),
      })
    } catch (err) {
      throw toNetworkError(err)
    }
    if (res.status === 404 || res.status === 405) {
      throw new AiError('This endpoint does not expose model discovery.', {
        code: 'model_discovery_unsupported',
        status: 404,
      })
    }
    if (!res.ok) throw await providerHttpError('Anthropic models', res)

    let page: RawAnthropicModelsResponse | null
    try {
      page = await readBoundedJson<RawAnthropicModelsResponse>(res)
    } catch (err) {
      if (err instanceof ResponseTooLargeError || err instanceof ResponseMalformedError) {
        throw new AiError('Model discovery returned an invalid response.', {
          code: 'ai_provider_malformed_response',
          status: 502,
        })
      }
      throw err
    }
    if (!page || !Array.isArray(page.data)) break
    pages.push(page)
    // Pagination stops unless the gateway positively signals more with
    // BOTH the flag and the cursor — absent fields are handled, not trusted.
    const lastId = typeof page.last_id === 'string' ? page.last_id : ''
    const wantsMore = page.has_more === true && lastId.length > 0
    if (!wantsMore) break
    if (pageNo === ANTHROPIC_MAX_PAGES - 1) {
      morePending = true // budget exhausted while more existed
      break
    }
    after = lastId
  }
  const catalog = normalizeAnthropicModels(pages)
  return morePending ? { ...catalog, completeness: 'bounded' } : catalog
}

/** Adapter registration object for the protocol registry. */
export const anthropicAdapter: ProviderAdapter = {
  protocol: 'anthropic',
  generate: generateAnthropic,
  listModels: listAnthropicModels,
}
