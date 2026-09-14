import { AiError, type AiUsage, type ChatMessage } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  normalizeUsage,
  providerHttpError,
  providerFetch,
  toNetworkError,
} from './shared'
import { joinApiPath } from '../outbound/url-join'
import { readBoundedJson, ResponseTooLargeError, ResponseMalformedError } from '../outbound/bounded-json'
import { normalizeGeminiModels } from './normalize'
import type { ModelCatalog } from './model-types'
import type {
  AdapterContext,
  ProviderAdapter,
  ProviderEmbeddingInput,
  ProviderGenerateInput,
  ProviderResult,
} from './contract'

// ============================================================
// Gemini Native adapter (ADR-003).
//
// Implements the official Google AI Studio surface directly — NOT
// Gemini's OpenAI-compatibility shim — so supportedGenerationMethods,
// token limits and blocked-response semantics arrive as the provider
// declares them.
//
// Endpoints (v1beta):
//   POST /models/{model}:generateContent
//   GET  /models?pageSize=&pageToken=
//   POST /models/{model}:embedContent     (seam only; not wired to the
//                                          KB until Phase 05)
//
// Verified 2026-09-04 from this environment: the endpoint paths are
// live (unauthenticated GET /v1beta/models answers 403 per policy).
// The docs site itself (ai.google.dev) timed out regionally, so the
// request/response field-level contract below follows the published
// v1beta schema from prior review and is listed as a human-gate
// re-verification item in the Phase 04 report.
//
// Auth: the key travels ONLY in the `x-goog-api-key` header — never a
// query param — so it cannot leak into URLs, logs, or error text.
// ============================================================

/** Root INCLUDING the version segment (Master §9.4). */
export const GEMINI_DEFAULT_ROOT = 'https://generativelanguage.googleapis.com/v1beta/'

// ---- id normalization (FR-MOD-04 / anti-double-prefix) --------

/** Accepts `gemini-2.5-flash` or `models/gemini-2.5-flash`; returns
 *  the bare id used for stored selection and display. */
export function normalizeGeminiId(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.startsWith('models/') ? trimmed.slice('models/'.length) : trimmed
}

/** Bare id → path segment that already carries the required prefix. */
function geminiPathSegment(model: string): string {
  const id = normalizeGeminiId(model)
  if (!id) throw new AiError('Gemini model id must not be empty.', { code: 'invalid_request', status: 400 })
  return `models/${id}`
}

// ---- response types (subset) ----------------------------------

interface GeminiPart {
  text?: string
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[]; role?: string }
  finishReason?: string
}

interface GeminiGenerateResponse {
  candidates?: GeminiCandidate[]
  promptFeedback?: { blockReason?: string }
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

interface GeminiEmbedResponse {
  embedding?: { values?: unknown }
}

// ---- helpers ---------------------------------------------------

function geminiHeaders(apiKey: string): Record<string, string> {
  return {
    'x-goog-api-key': apiKey,
    'Content-Type': 'application/json',
  }
}

/** ChatMessage roles → Gemini `contents` (`assistant` becomes `model`). */
function toGeminiContents(messages: ChatMessage[]): { role: string; parts: { text: string }[] }[] {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
}

function safeUrlForError(ctx: AdapterContext, path: string): string {
  // Only used for messages; NEVER contains the key (it stays in headers).
  const root = ctx.apiRoot ?? GEMINI_DEFAULT_ROOT
  return String(joinApiPath(root, path))
}

// ---- generate ---------------------------------------------------

export async function generateGemini(
  ctx: AdapterContext,
  input: ProviderGenerateInput,
): Promise<ProviderResult> {
  const { apiKey, timeoutMs } = ctx
  const { model, systemPrompt, messages } = input
  const path = `${geminiPathSegment(model)}:generateContent`

  let res: Response
  try {
    res = await providerFetch(ctx, safeUrlForError(ctx, path), {
      method: 'POST',
      headers: geminiHeaders(apiKey),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: toGeminiContents(messages),
        generationConfig: {
          maxOutputTokens: ctx.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
          ...(ctx.temperature != null ? { temperature: ctx.temperature } : {}),
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Gemini', res)
  }

  let data: GeminiGenerateResponse | null
  try {
    data = await readBoundedJson<GeminiGenerateResponse>(res)
  } catch (err) {
    if (err instanceof ResponseTooLargeError || err instanceof ResponseMalformedError) {
      throw new AiError('Gemini returned an invalid response.', { code: 'empty_response' })
    }
    throw err
  }

  // Policy block comes through promptFeedback, not HTTP status.
  if (data?.promptFeedback?.blockReason) {
    throw new AiError('Gemini blocked the request by policy.', {
      code: 'blocked_by_provider',
      status: 502,
    })
  }

  const candidate = data?.candidates?.[0]
  const finish = candidate?.finishReason
  if (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS') {
    // SAFETY / BLOCKLIST / RECITATION / PROHIBITED_CONTENT / SPII…
    throw new AiError('Gemini returned no usable answer.', {
      code: 'blocked_by_provider',
      status: 502,
    })
  }

  const text = (candidate?.content?.parts ?? [])
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim()
  if (!text) {
    throw new AiError('Gemini returned an empty response.', { code: 'empty_response' })
  }

  const usage: AiUsage | null = normalizeUsage({
    prompt: data?.usageMetadata?.promptTokenCount,
    completion: data?.usageMetadata?.candidatesTokenCount,
    total: data?.usageMetadata?.totalTokenCount,
  })
  return { text, usage }
}

// ---- listModels -------------------------------------------------

const GEMINI_PAGE_SIZE = 100
const GEMINI_MAX_PAGES = 5

interface RawGeminiModelsResponse {
  models?: unknown[]
  nextPageToken?: string
}

/**
 * Official native list with `pageToken` pagination, bounded to
 * GEMINI_MAX_PAGES pages. Capabilities come from
 * `supportedGenerationMethods` (authoritative) — never from name
 * heuristics (ADR-005 rules apply).
 */
export async function listGeminiModels(ctx: AdapterContext): Promise<ModelCatalog> {
  const pages: RawGeminiModelsResponse[] = []
  let pageToken = ''
  let pageCapHit = false
  for (let pageNo = 0; pageNo < GEMINI_MAX_PAGES; pageNo++) {
    const path = pageToken
      ? `models?pageSize=${GEMINI_PAGE_SIZE}&pageToken=${encodeURIComponent(pageToken)}`
      : `models?pageSize=${GEMINI_PAGE_SIZE}`
    let res: Response
    try {
      res = await providerFetch(ctx, safeUrlForError(ctx, path), {
        method: 'GET',
        headers: { 'x-goog-api-key': ctx.apiKey },
        signal: AbortSignal.timeout(ctx.timeoutMs),
      })
    } catch (err) {
      throw toNetworkError(err)
    }
    if (res.status === 404 || res.status === 405) {
      throw new AiError('Gemini is not exposing model discovery.', {
        code: 'model_discovery_unsupported',
        status: 404,
      })
    }
    if (!res.ok) throw await providerHttpError('Gemini models', res)

    let page: RawGeminiModelsResponse | null
    try {
      page = await readBoundedJson<RawGeminiModelsResponse>(res)
    } catch (err) {
      if (err instanceof ResponseTooLargeError || err instanceof ResponseMalformedError) {
        throw new AiError('Model discovery returned an invalid response.', {
          code: 'ai_provider_malformed_response',
          status: 502,
        })
      }
      throw err
    }
    if (!page) break
    pages.push(page)
    if (!page.nextPageToken) break
    if (pageNo === GEMINI_MAX_PAGES - 1) {
      // more data existed but our budget is done — say so honestly
      pageCapHit = true
      break
    }
    pageToken = page.nextPageToken
  }
  const catalog = normalizeGeminiModels(pages)
  return pageCapHit ? { ...catalog, completeness: 'bounded' } : catalog
}

// ---- embed (seam only; vectors never persisted pre-Phase-05) ----

export async function embedGemini(
  ctx: AdapterContext,
  input: ProviderEmbeddingInput,
): Promise<number[][]> {
  const out: number[][] = []
  for (const text of input.inputs) {
    const path = `${geminiPathSegment(input.model)}:embedContent`
    let res: Response
    try {
      res = await providerFetch(ctx, safeUrlForError(ctx, path), {
        method: 'POST',
        headers: geminiHeaders(ctx.apiKey),
        body: JSON.stringify({ content: { parts: [{ text }] } }),
        signal: AbortSignal.timeout(ctx.timeoutMs),
      })
    } catch (err) {
      throw toNetworkError(err)
    }
    if (!res.ok) throw await providerHttpError('Gemini embeddings', res)
    let parsed: GeminiEmbedResponse | null
    try {
      parsed = await readBoundedJson<GeminiEmbedResponse>(res)
    } catch {
      throw new AiError('Embeddings response was malformed.', { code: 'embeddings_malformed' })
    }
    const values = parsed?.embedding?.values
    if (!Array.isArray(values) || values.length === 0) {
      throw new AiError('Embeddings response missing a vector.', { code: 'embeddings_malformed' })
    }
    // Reject non-finite BEFORE any vector literal could be built.
    const vec = values.map((v) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new AiError('Embeddings contained a non-finite value.', {
          code: 'embeddings_malformed',
        })
      }
      return v
    })
    out.push(vec)
  }
  return out
}

export const geminiAdapter: ProviderAdapter = {
  protocol: 'gemini_native',
  generate: generateGemini,
  listModels: listGeminiModels,
  embed: embedGemini,
}
