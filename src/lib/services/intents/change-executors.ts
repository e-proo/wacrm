import { supabaseAdmin } from '@/lib/ai/admin-client'
import {
  DomainChangeExecutionError,
  type ChangeExecutorRegistration,
} from '@/lib/services/platform/change-executor-registry'

const decideIntentExecutor: ChangeExecutorRegistration['executor'] = async (
  context,
  change,
) => {
  if (!change.targetId) {
    throw new DomainChangeExecutionError(
      'INTENT_DECISION_TARGET_REQUIRED',
      'Approved intent decision is missing its target intent.',
    )
  }

  const decision = change.proposedPayload.decision as string | undefined
  const allowed = new Set(['fulfilled', 'rejected', 'matched', 'clarifying'])
  if (!decision || !allowed.has(decision)) {
    throw new DomainChangeExecutionError(
      'DECISION_REQUIRED',
      `decision must be one of: ${[...allowed].join(', ')}.`,
    )
  }

  const update: Record<string, unknown> = { status: decision }
  if (decision === 'matched') {
    const serviceId = change.proposedPayload.matched_service_id as
      | string
      | undefined
    if (!serviceId) {
      throw new DomainChangeExecutionError(
        'MATCHED_SERVICE_REQUIRED',
        'matched_service_id is required when decision=matched.',
      )
    }

    const { data: service, error: serviceError } = await supabaseAdmin()
      .from('services')
      .select('id')
      .eq('account_id', context.accountId)
      .eq('id', serviceId)
      .maybeSingle()
    if (serviceError) throw serviceError
    if (!service) {
      throw new DomainChangeExecutionError(
        'SERVICE_NOT_FOUND',
        'Matched service not found in this account.',
        404,
      )
    }
    update.matched_service_id = serviceId
  }

  const { data: intent, error: updateError } = await supabaseAdmin()
    .from('customer_intents')
    .update(update)
    .eq('account_id', context.accountId)
    .eq('id', change.targetId)
    .select('id')
    .maybeSingle()
  if (updateError) throw updateError
  if (!intent) {
    throw new DomainChangeExecutionError(
      'INTENT_NOT_FOUND',
      'Customer intent was not found.',
      404,
    )
  }

  return {
    target_type: change.targetType,
    target_id: change.targetId,
    operation: 'intent_decision',
    decision,
    customer_notification: {
      intent_id: change.targetId,
      event_type:
        decision === 'rejected'
          ? 'rejected'
          : decision === 'clarifying'
            ? 'needs_clarification'
            : decision === 'matched'
              ? 'matched'
              : 'approved_and_applied',
      message_text:
        decision === 'rejected'
          ? 'تمت مراجعة طلبك من الإدارة ولم يتم اعتماده.'
          : decision === 'clarifying'
            ? 'راجعت الإدارة طلبك وتحتاج إلى معلومات إضافية قبل اتخاذ القرار.'
            : decision === 'matched'
              ? 'تمت مراجعة طلبك وربطه بخدمة متوفرة لدينا.'
              : 'تمت مراجعة طلبك واعتماده من الإدارة.',
    },
  }
}

export const INTENTS_CHANGE_EXECUTORS: readonly ChangeExecutorRegistration[] = [
  {
    actionKey: 'intents.decision.apply',
    actionVersion: 1,
    executor: decideIntentExecutor,
  },
]
