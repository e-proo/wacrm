import { isOpenWATestProject } from '@/lib/whatsapp/transport/guardrails'
import { supabaseAdmin } from '../admin-client'

/**
 * The per-account control is additive to every existing policy/consent gate.
 * Missing policy rows default to the historic enabled state; a storage error
 * fails closed. This switch is only enforced on pinned TEST, never Production.
 */
export async function isTestAgentTaskWorkerEnabled(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
): Promise<boolean> {
  if (!isOpenWATestProject()) return true
  const { data, error } = await db.from('ai_runtime_policies')
    .select('task_worker_enabled')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw error
  return data?.task_worker_enabled !== false
}
