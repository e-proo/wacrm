import type { ChatMessage, AiUsage } from '../types'
import type { ModelInfo, ModelCatalog } from './model-types'

// ============================================================
// Adapter contract — the narrow surface every provider implements.
// Adapters speak HTTP only: no Supabase, no session, no env beyond
// the connection handed in. Phase 01 keeps this contract minimal
// (generate + optional listModels + optional embed) per ADR-010.
// ============================================================

/** Protocol identifier a registered adapter is bound to. Stable
 *  strings; the registry maps these to implementations.
 *  - `openai`    — OpenAI-compatible chat/list (OpenAI, DeepSeek, …)
 *  - `anthropic` — official Anthropic Messages API
 *  - `gemini_native` — Google AI Studio generateContent API (ADR-003) */
export type ProviderProtocol = 'openai' | 'anthropic' | 'gemini_native'

export interface AdapterContext {
  /** Decrypted API key — server-only, never logged. */
  apiKey: string
  /** Per-call timeout, applied by the adapter. */
  timeoutMs: number
  /** Optional correlation ID for logs. */
  requestId?: string
  /**
   * Server-validated API root from the RuntimeConnection (Phase 03+).
   * When absent, adapters fall back to their preset default — this is
   * what keeps the legacy `ai_configs` path byte-identical until the
   * switch-over. Never sourced from a client request body.
   */
  apiRoot?: URL | string
  /**
   * True when the stored connection's root came from a `custom`
   * preset (derived server-side from the preset id). Custom roots are
   * routed through the outbound SSRF policy (validate + classify every
   * DNS answer) before any request leaves the process; fixed preset
   * roots (code-defined hostnames) skip that indirection.
   */
  customEndpoint?: boolean
}

export interface ProviderGenerateInput {
  model: string
  systemPrompt: string
  messages: ChatMessage[]
}

export interface ProviderEmbeddingInput {
  model: string
  inputs: string[]
}

/** Raw text + usage an adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string
  usage: AiUsage | null
}

export interface ProviderAdapter {
  readonly protocol: ProviderProtocol
  generate(
    ctx: AdapterContext,
    input: ProviderGenerateInput,
  ): Promise<ProviderResult>
  listModels?(ctx: AdapterContext): Promise<ModelCatalog>
  embed?(ctx: AdapterContext, input: ProviderEmbeddingInput): Promise<number[][]>
}

// Stable identity of the normalization rules. Stored inside each
// cached catalog envelope; bumping it makes every cached catalog go
// stale without touching the DB (docs: cache key includes an adapter
// catalog version).
export const CATALOG_SCHEMA_VERSION = 1 as const

// Re-exported for adapters and tests.
export type { ModelInfo, ModelCatalog }