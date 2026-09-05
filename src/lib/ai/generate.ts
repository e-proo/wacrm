import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { getAdapter } from './providers/registry'
import type { ProviderProtocol } from './providers/contract'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches via the protocol registry to the registered adapter, then
 * parses the handoff sentinel out of the raw text. Throws `AiError` on
 * any provider/network failure.
 *
 * Priority (Phase 05): when the config carries a decrypted chat
 * connection (`config.chat`, flag-gated in `loadAiConfig`), that drives
 * the call — protocol, key, validated API root, model. Otherwise the
 * legacy provider fields do. Either path ends up in the same registry
 * lookup with the same error contract, and no consumer knows a brand.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const chat = config.chat
  const apiKey = chat?.apiKey ?? config.apiKey
  if (!apiKey) {
    // Defensive only: `loadAiConfig` already returns null for configs
    // with neither a legacy key nor a linked connection.
    throw new AiError('No provider credentials are configured for this account.', {
      code: 'key_decrypt_failed',
      status: 400,
    })
  }
  const adapter = getAdapter((chat?.protocol ?? config.provider) as ProviderProtocol)
  const result = await adapter.generate(
    {
      apiKey,
      timeoutMs,
      apiRoot: chat?.apiRoot,
      customEndpoint: chat?.customEndpoint ?? false,
    },
    { model: chat?.model ?? config.model, systemPrompt, messages },
  )

  return parseGeneration(result.text, result.usage)
}

/**
 * The protocol/mode a *usage log* row should record for this config:
 * the live chat connection wins so Gemini/DeepSeek spend is attributed
 * correctly (042 widened the CHECK accordingly).
 */
export function usageProvider(config: AiConfig): string {
  return config.chat?.protocol ?? config.provider
}

/** Live model name for logging/UI when chat may come from a connection. */
export function usageModel(config: AiConfig): string {
  return config.chat?.model ?? config.model
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const text = raw.split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff, usage }
}
