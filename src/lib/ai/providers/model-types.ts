import type { ChatMessage } from '../types'

// ============================================================
// Generic model metadata produced by adapter.listModels.
// Adapters normalize provider-specific shapes (OpenAI's `data[]`,
// Anthropic's cursor-paginated list, Gemini's `models[]`) into this
// shape. Capabilities are tri-state per ADR-005: `supported`,
// `unsupported`, `unknown`. Today Phase 01 does not yet call
// listModels; the type is here so adding it in Phase 03 is
// non-breaking.
// ============================================================

export type CapabilityState = 'supported' | 'unsupported' | 'unknown'

export interface ProviderCapabilities {
  chat: CapabilityState
  embeddings: CapabilityState
  modelDiscovery: CapabilityState
}

export interface ModelInfo {
  id: string
  displayName?: string
  capabilities: ProviderCapabilities
  ownedBy?: string
  inputTokenLimit?: number
  outputTokenLimit?: number
  /** Provider's original id (e.g. `models/gemini-…`). Internal use. */
  rawProviderId?: string
}

export interface ModelCatalog {
  models: ModelInfo[]
  fetchedAt: string
  source: 'provider' | 'cache'
  completeness: 'complete' | 'bounded'
}

/** Helper used by adapters to assert message shape invariants. */
export function assertChatMessages(messages: ChatMessage[]): ChatMessage[] {
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') {
      throw new Error(`Invalid chat role: ${String((m as { role: unknown }).role)}`)
    }
    if (typeof m.content !== 'string') {
      throw new Error('Chat message content must be a string')
    }
  }
  return messages
}