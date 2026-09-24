import type { SupabaseClient } from '@supabase/supabase-js'

export class RuntimeBudgetError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'RuntimeBudgetError'
  }
}

export async function reserveRuntimeBudget(args: {
  db: SupabaseClient
  accountId: string
  runId: string | null
  estimatedInputTokens: number
  estimatedOutputTokens: number
}): Promise<void> {
  if (!args.runId) return
  const { data, error } = await args.db.rpc('reserve_ai_agent_runtime_budget', {
    p_account_id: args.accountId,
    p_run_id: args.runId,
    p_estimated_input_tokens: Math.max(0, Math.floor(args.estimatedInputTokens)),
    p_estimated_output_tokens: Math.max(0, Math.floor(args.estimatedOutputTokens)),
  })
  if (error) throw error
  if (typeof data === 'string' && data) throw new RuntimeBudgetError(data)
}

export async function releaseRuntimeBudget(db: SupabaseClient, runId: string | null): Promise<void> {
  if (!runId) return
  const { error } = await db.rpc('release_ai_agent_runtime_budget', { p_run_id: runId })
  if (error) console.error('[ai runtime] budget release failed:', error)
}
