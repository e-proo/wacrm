import { AiError } from '../types'
import { openaiAdapter } from './openai'
import { anthropicAdapter } from './anthropic'
import { geminiAdapter } from './gemini'
import type { ProviderAdapter, ProviderProtocol } from './contract'

// ============================================================
// Adapter registry — immutable map Protocol → Adapter.
//
// The DB CHECK on ai_provider_connections.protocol (migration 041)
// must enumerate the same values as ProviderProtocol; keep them in
// lockstep. Per ADR-001 the registry's value type is `ProviderAdapter`,
// not a brand string: protocol is the dispatch key, never a way to
// pick an implementation from untrusted input, and consumers keep no
// provider-name branches of their own.
// ============================================================

const ADAPTERS: ReadonlyMap<ProviderProtocol, ProviderAdapter> = new Map<
  ProviderProtocol,
  ProviderAdapter
>([
  ['openai', openaiAdapter],
  ['anthropic', anthropicAdapter],
  ['gemini_native', geminiAdapter],
])

/**
 * Resolve an adapter by protocol. Throws `AiError` with
 * `unsupported_provider` for unknown protocols — the same code the
 * pre-registry `switch` produced, so callers and tests see identical
 * behavior.
 */
export function getAdapter(protocol: ProviderProtocol): ProviderAdapter {
  const adapter = ADAPTERS.get(protocol)
  if (!adapter) {
    throw new AiError(`Unsupported AI provider: ${protocol}`, {
      code: 'unsupported_provider',
      status: 400,
    })
  }
  return adapter
}

/** Test/inspection helper: list registered protocols. */
export function listRegisteredProtocols(): ProviderProtocol[] {
  return Array.from(ADAPTERS.keys())
}