import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Recovery worker — picks up runs whose lease expired.
//
// Phase 1 ships the stub + service-role RPC. A real deployment
// runs this on a scheduler; locally it can be invoked from a
// `__test__` API or a one-off script.
// ============================================================

export interface RecoverySweepResult {
  scanned: number
  reaped: number
}

/**
 * Reclaim queued / expired-lease runs and mark them as failed
 * if they're past their max attempts. We do NOT auto-retry in
 * Phase 1 — auto-retry logic lands in Phase 3 alongside the
 * tool-call timeout policies.
 */
export async function sweepAgentRuns(
  db: SupabaseClient,
  opts: { now?: Date } = {},
): Promise<RecoverySweepResult> {
  const now = opts.now ?? new Date()
  const { data: expired, error } = await db
    .from('ai_agent_runs')
    .select('id, account_id, attempt_count')
    .in('status', ['claimed'])
    .lt('lease_expires_at', now.toISOString())
    .limit(200)
  if (error) throw error
  let reaped = 0
  for (const row of expired ?? []) {
    const r = row as { id: string; account_id: string; attempt_count: number }
    const nextStatus = r.attempt_count >= 10 ? 'failed' : 'queued'
    const { error: updErr } = await db
      .from('ai_agent_runs')
      .update({
        status: nextStatus,
        lease_expires_at: null,
        claimed_by: null,
        available_at: now.toISOString(),
        error_code: nextStatus === 'failed' ? 'LEASE_LOST_MAX_ATTEMPTS' : null,
        completed_at: nextStatus === 'failed' ? now.toISOString() : null,
      })
      .eq('id', r.id)
      .eq('status', 'claimed')
    if (updErr) {
      console.error('[ai sweep] failed to reap run:', updErr)
      continue
    }
    reaped++
    await db.rpc('append_agent_run_event', {
      p_account_id: r.account_id,
      p_run_id: r.id,
      p_event_type: nextStatus === 'failed' ? 'failed' : 'claimed',
      p_actor_type: 'system',
      p_actor_id: 'recovery-sweep',
      p_payload: { reason: 'lease_expired', attempt: r.attempt_count },
    })
  }
  return { scanned: (expired ?? []).length, reaped }
}
