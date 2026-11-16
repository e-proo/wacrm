import type { SupabaseClient } from '@supabase/supabase-js'
import type { WhatsAppSendWorkload } from '@/lib/whatsapp/transport/types'

export interface BusinessEventWorkloadRow {
  event_type: string
  subject_id: string
  correlation_id: string | null
  contact_id: string | null
  conversation_id: string | null
}
interface ChangeRequestBinding {
  id: string
  status: string
  action_key: string | null
  execution_result: unknown
  proposed_payload: unknown
}
interface TaskBinding { task_type: string; task_type_version: number }
interface TargetBinding { task_id: string; contact_id: string; conversation_id: string }
interface SupplierBinding {
  task_id: string
  task_target_id: string
  contact_id: string
  conversation_id: string
  change_request_id: string
  stage: string
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

export function isVerifiedAgentTaskBusinessOutcome(input: {
  event: BusinessEventWorkloadRow
  change: ChangeRequestBinding | null
  task: TaskBinding | null
  target: TargetBinding | null
  supplier: SupplierBinding | null
}): boolean {
  const { event, change, task, target, supplier } = input
  if (event.event_type !== 'coverage.offer.approved' || !change ||
      !task || !target || !supplier || !event.contact_id || !event.conversation_id) return false
  const payload = object(change.proposed_payload)
  const offer = object(object(change.execution_result).offer)
  return change.status === 'executed' && change.action_key === 'coverage.offer.create' &&
    event.correlation_id === change.id && offer.id === event.subject_id &&
    payload.source_task_id === supplier.task_id &&
    payload.source_task_target_id === supplier.task_target_id &&
    payload.contact_id === event.contact_id &&
    payload.conversation_id === event.conversation_id &&
    task.task_type === 'coverage.sourcing' && task.task_type_version === 2 &&
    target.task_id === supplier.task_id &&
    target.contact_id === event.contact_id &&
    target.conversation_id === event.conversation_id &&
    supplier.contact_id === event.contact_id &&
    supplier.conversation_id === event.conversation_id &&
    supplier.change_request_id === change.id && supplier.stage === 'submitted'
}

/**
 * Only the result of a verified, operator-approved Agent Task can use the
 * task's already-authorized 'agent' Pilot workload. Generic automations,
 * unrelated coverage offers, and other customer notifications retain their
 * separate 'automation' admission requirement. No session/recipient grants
 * are ever created here.
 */
export async function resolveBusinessEventSendWorkload(
  db: SupabaseClient,
  accountId: string,
  event: BusinessEventWorkloadRow,
): Promise<WhatsAppSendWorkload> {
  if (event.event_type !== 'coverage.offer.approved' || !event.correlation_id ||
      !event.contact_id || !event.conversation_id) return 'automation'
  const { data: change, error: ce } = await db.from('change_requests')
    .select('id,status,action_key,proposed_payload,execution_result')
    .eq('account_id', accountId).eq('id', event.correlation_id).maybeSingle()
  if (ce) throw ce
  const payload = object(change?.proposed_payload)
  const taskId = payload.source_task_id
  const targetId = payload.source_task_target_id
  if (typeof taskId !== 'string' || typeof targetId !== 'string') return 'automation'
  const [taskResult, targetResult, supplierResult] = await Promise.all([
    db.from('ai_agent_tasks').select('task_type,task_type_version')
      .eq('account_id',accountId).eq('id',taskId).maybeSingle(),
    db.from('ai_agent_task_targets').select('task_id,contact_id,conversation_id')
      .eq('account_id',accountId).eq('task_id',taskId).eq('id',targetId).maybeSingle(),
    db.from('ai_agent_coverage_supplier_negotiations')
      .select('task_id,task_target_id,contact_id,conversation_id,change_request_id,stage')
      .eq('account_id',accountId).eq('task_id',taskId).eq('task_target_id',targetId)
      .eq('change_request_id',event.correlation_id).maybeSingle(),
  ])
  if (taskResult.error || targetResult.error || supplierResult.error) {
    throw taskResult.error ?? targetResult.error ?? supplierResult.error
  }
  return isVerifiedAgentTaskBusinessOutcome({
    event, change: change as ChangeRequestBinding | null,
    task: taskResult.data as TaskBinding | null,
    target: targetResult.data as TargetBinding | null,
    supplier: supplierResult.data as SupplierBinding | null,
  }) ? 'agent' : 'automation'
}
