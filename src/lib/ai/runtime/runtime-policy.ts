import type { SupabaseClient } from '@supabase/supabase-js'
import type { RuntimeFeaturePolicy } from './tool-policy'

export interface AccountRuntimePolicy extends RuntimeFeaturePolicy {
  multiAgentEnabled: boolean
  adminPlaneEnabled: boolean
  recoveryWorkerEnabled: boolean
  maxRunsPerMinute: number
  dailyInputTokenBudget: number | null
  dailyOutputTokenBudget: number | null
}

/** Fail closed for dangerous features when no row exists. */
export async function loadAccountRuntimePolicy(
  db: SupabaseClient,
  accountId: string,
): Promise<AccountRuntimePolicy> {
  const { data, error } = await db
    .from('ai_runtime_policies')
    .select('multi_agent_enabled, admin_plane_enabled, native_tools_enabled, proposal_tools_enabled, recovery_worker_enabled, kill_switch, max_runs_per_minute, daily_input_token_budget, daily_output_token_budget')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw error
  if (!data) {
    return {
      multiAgentEnabled: process.env.MULTI_AGENT_ENABLED === 'true',
      adminPlaneEnabled: false,
      recoveryWorkerEnabled: false,
      nativeToolsEnabled: false,
      proposalToolsEnabled: false,
      killSwitch: false,
      maxRunsPerMinute: 30,
      dailyInputTokenBudget: null,
      dailyOutputTokenBudget: null,
    }
  }
  const r = data as Record<string, unknown>
  return {
    multiAgentEnabled: r.multi_agent_enabled === true,
    adminPlaneEnabled: r.admin_plane_enabled === true,
    recoveryWorkerEnabled: r.recovery_worker_enabled === true,
    nativeToolsEnabled: r.native_tools_enabled === true,
    proposalToolsEnabled: r.proposal_tools_enabled === true,
    killSwitch: r.kill_switch === true,
    maxRunsPerMinute: Number(r.max_runs_per_minute ?? 30),
    dailyInputTokenBudget: r.daily_input_token_budget == null ? null : Number(r.daily_input_token_budget),
    dailyOutputTokenBudget: r.daily_output_token_budget == null ? null : Number(r.daily_output_token_budget),
  }
}
