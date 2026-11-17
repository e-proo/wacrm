import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentTaskCompletionDecision } from './completion-policy'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type EvaluatedCompletion = AgentTaskCompletionDecision & { finalized: boolean }

/**
 * Immediately reconsider the sourcing Task after an admin-approved Coverage
 * Offer has durably EXECUTED. This is a best-effort post-commit hook, never a
 * second Change Request execution or a substitute for the domain policy.
 *
 * Tenant + source Request/Task/Target bindings are checked again before
 * evaluating: no unscoped service-role reference can finalize another account.
 * Counteroffer review actions and unexecuted target proposals are excluded.
 */
export async function finalizeTaskAfterApprovedCoverageOffer(input: {
  db: SupabaseClient
  accountId: string
  actionKey: string | null
  targetType: string
  proposedPayload: Readonly<Record<string, unknown>>
  evaluate: (taskId: string) => Promise<EvaluatedCompletion>
}): Promise<EvaluatedCompletion | null> {
  if (input.actionKey !== 'coverage.offer.create' ||
      input.targetType !== 'coverage_offer') return null

  const taskId = input.proposedPayload.source_task_id
  const targetId = input.proposedPayload.source_task_target_id
  const requestId = input.proposedPayload.source_coverage_request_id
  if (typeof taskId !== 'string' || !UUID_RE.test(taskId) ||
      typeof targetId !== 'string' || !UUID_RE.test(targetId) ||
      typeof requestId !== 'string' || !UUID_RE.test(requestId)) return null

  const [taskResult, targetResult] = await Promise.all([
    input.db.from('ai_agent_tasks')
      .select('id,task_type,status,task_context')
      .eq('account_id', input.accountId)
      .eq('id', taskId).maybeSingle(),
    input.db.from('ai_agent_task_targets')
      .select('id,status')
      .eq('account_id', input.accountId)
      .eq('task_id', taskId)
      .eq('id', targetId).maybeSingle(),
  ])
  if (taskResult.error) throw taskResult.error
  if (targetResult.error) throw targetResult.error

  const task = taskResult.data
  const target = targetResult.data
  const snapshot = task?.task_context && typeof task.task_context === 'object' &&
    !Array.isArray(task.task_context)
    ? task.task_context as Record<string, unknown>
    : null
  if (!task || task.task_type !== 'coverage.sourcing' ||
      task.status !== 'running' ||
      snapshot?.coverageRequestId !== requestId ||
      !target || target.status !== 'completed') return null

  return input.evaluate(taskId)
}
