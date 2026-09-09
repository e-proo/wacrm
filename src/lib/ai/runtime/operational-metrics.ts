import { supabaseAdmin } from '../admin-client'

// ============================================================
// Operational metrics — the agent-operations view ONLY.
//
// Deliberately EXCLUDES token-spend aggregates: those live in
// `retrieveAiUsageStats` (src/lib/ai/usage.ts) surfaced by the
// "Usage" tab, which already renders them per model / mode / day.
// Duplicating the same totals here created two competing
// dashboards for the same `ai_usage_log` rows (cleanup 2026-09).
//
// This module answers "are my AGENTS healthy?": run statuses,
// tool call health, and recent failure codes. Failed runs keep a
// compact count here; the full forensic list stays in the Runs
// tab (agent-runs-panel).
// ============================================================

export interface OperationalMetrics {
  runs: Record<string, number>
  failedRuns: number
  tools: Array<{ toolKey: string; calls: number; failures: number }>
}

/** Account-scoped aggregate used by the operational dashboard. */
export async function getOperationalMetrics(
  accountId: string,
  since?: string,
): Promise<OperationalMetrics> {
  const db = supabaseAdmin()
  const start = since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const [runs, tools] = await Promise.all([
    db.from('ai_agent_runs').select('status, error_code').eq('account_id', accountId).gte('created_at', start),
    db.from('ai_agent_tool_call_attempts').select('tool_key, status').eq('account_id', accountId).gte('created_at', start),
  ])
  if (runs.error) throw runs.error
  if (tools.error) throw tools.error

  const runTotals: Record<string, number> = {}
  let failedRuns = 0
  for (const row of runs.data ?? []) {
    const r = row as { status: string; error_code: string | null }
    runTotals[r.status] = (runTotals[r.status] ?? 0) + 1
    if (r.status === 'failed' || (r.status === 'skipped' && r.error_code)) failedRuns += 1
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
    runs: runTotals,
    failedRuns,
    tools: [...toolMap.entries()].map(([toolKey, value]) => ({ toolKey, ...value })),
  }
}
