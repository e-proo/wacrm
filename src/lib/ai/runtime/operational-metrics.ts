import { supabaseAdmin } from '../admin-client'

export interface OperationalMetrics {
  usage: {
    calls: number
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  runs: Record<string, number>
  tools: Array<{ toolKey: string; calls: number; failures: number }>
  recentErrors: Array<{ source: string; code: string; createdAt: string }>
}

/** Account-scoped aggregate used by the operational dashboard. */
export async function getOperationalMetrics(
  accountId: string,
  since?: string,
): Promise<OperationalMetrics> {
  const db = supabaseAdmin()
  const start = since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const [usage, runs, tools, errors] = await Promise.all([
    db.from('ai_usage_log').select('prompt_tokens, completion_tokens, total_tokens').eq('account_id', accountId).gte('created_at', start),
    db.from('ai_agent_runs').select('status').eq('account_id', accountId).gte('created_at', start),
    db.from('ai_agent_tool_call_attempts').select('tool_key, status').eq('account_id', accountId).gte('created_at', start),
    db.from('ai_agent_runs').select('error_code, created_at').eq('account_id', accountId).not('error_code', 'is', null).gte('created_at', start).order('created_at', { ascending: false }).limit(20),
  ])
  if (usage.error) throw usage.error
  if (runs.error) throw runs.error
  if (tools.error) throw tools.error
  if (errors.error) throw errors.error
  const usageTotals = (usage.data ?? []).reduce((sum, row) => {
    const r = row as { prompt_tokens: number; completion_tokens: number; total_tokens: number }
    return {
      calls: sum.calls + 1,
      promptTokens: sum.promptTokens + (r.prompt_tokens ?? 0),
      completionTokens: sum.completionTokens + (r.completion_tokens ?? 0),
      totalTokens: sum.totalTokens + (r.total_tokens ?? 0),
    }
  }, { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 })
  const runTotals: Record<string, number> = {}
  for (const row of runs.data ?? []) {
    const status = (row as { status: string }).status
    runTotals[status] = (runTotals[status] ?? 0) + 1
  }
  const toolMap = new Map<string, { calls: number; failures: number }>()
  for (const row of tools.data ?? []) {
    const r = row as { tool_key: string; status: string }
    const current = toolMap.get(r.tool_key) ?? { calls: 0, failures: 0 }
    current.calls += 1
    if (r.status === 'failed' || r.status === 'denied') current.failures += 1
    toolMap.set(r.tool_key, current)
  }
  return {
    usage: usageTotals,
    runs: runTotals,
    tools: [...toolMap.entries()].map(([toolKey, value]) => ({ toolKey, ...value })),
    recentErrors: (errors.data ?? []).map((row) => ({
      source: 'agent_run',
      code: (row as { error_code: string }).error_code,
      createdAt: (row as { created_at: string }).created_at,
    })),
  }
}
