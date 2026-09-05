import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiUsage } from './types'

export interface LogAiUsageArgs {
  accountId: string
  /** Null for a draft not tied to one thread, or when the row was
   *  deleted between generation and logging. */
  conversationId: string | null
  mode: 'auto_reply' | 'draft' | 'playground'
  /** The live protocol/provider (chat connection beats the legacy
   *  column — see `usageProvider`). Plain string: DB CHECK widened
   *  to the full protocol set in migration 042. */
  provider: string
  model: string
  /** The connection that served the call, when the account is on the
   *  connection path (spend attribution — migration 044). */
  connectionId?: string | null
  /** Provider usage. Since 044 a NULL is NOT a skip: the call still
   *  gets one row with zero counts + `usage_reported=false`, because
   *  "calls happened but this gateway reports no counts" is visible
   *  spending information (some compatible gateways omit usage). */
  usage: AiUsage | null
}

/**
 * Best-effort append to `ai_usage_log` — one row per LLM call, for cost
 * visibility on the account's key. NEVER throws: usage accounting must
 * not fail a reply the customer is waiting on, so any DB error is
 * logged and swallowed.
 *
 * Pass the service-role admin client from the webhook, or the RLS-scoped
 * SSR client from a route — writes land either way (there's no
 * `authenticated` INSERT policy, so an SSR write relies on the service
 * role; callers that must persist from a route should pass the admin
 * client).
 */
export async function logAiUsage(
  db: SupabaseClient,
  args: LogAiUsageArgs,
): Promise<void> {
  try {
    const { error } = await db.from('ai_usage_log').insert({
      account_id: args.accountId,
      conversation_id: args.conversationId,
      mode: args.mode,
      provider: args.provider,
      model: args.model,
      connection_id: args.connectionId ?? null,
      prompt_tokens: args.usage?.promptTokens ?? 0,
      completion_tokens: args.usage?.completionTokens ?? 0,
      total_tokens: args.usage?.totalTokens ?? 0,
      usage_reported: !!args.usage,
    })
    if (error) {
      console.error('[ai usage] log insert failed:', error)
    }
  } catch (err) {
    console.error('[ai usage] log insert threw:', err)
  }
}
