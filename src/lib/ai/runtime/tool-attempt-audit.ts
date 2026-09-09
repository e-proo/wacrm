import crypto from 'crypto'
import { supabaseAdmin } from '../admin-client'

/** Record a redacted tool attempt without storing its arguments. */
export async function recordToolAttempt(input: {
  accountId: string
  runId: string | null
  agentId: string | null
  revisionId: string | null
  toolKey: string
  toolVersion: number
  round: number
  permission: 'read' | 'propose' | 'execute'
  status: 'accepted' | 'denied' | 'succeeded' | 'failed'
  errorCode?: string
  args?: Record<string, unknown>
  durationMs?: number
}): Promise<void> {
  const inputHash = input.args
    ? crypto.createHash('sha256').update(JSON.stringify(input.args)).digest('hex')
    : null
  const { error } = await supabaseAdmin()
    .from('ai_agent_tool_call_attempts')
    .insert({
      account_id: input.accountId,
      run_id: input.runId,
      agent_id: input.agentId,
      revision_id: input.revisionId,
      tool_key: input.toolKey,
      tool_version: input.toolVersion,
      round: input.round,
      permission: input.permission,
      status: input.status,
      error_code: input.errorCode ?? null,
      input_hash: inputHash,
      duration_ms: input.durationMs ?? null,
    })
  if (error) {
    // Observability must never break the customer response.
    console.error('[tool audit] failed to record attempt:', error)
  }
}
