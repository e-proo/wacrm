import { supabaseAdmin } from '@/lib/ai/admin-client'
import { parseDecimal } from '@/lib/services/shared/money/decimal'
import { readCoverageAttributes } from './attributes'
import {
  DomainChangeExecutionError,
  type ChangeExecutorRegistration,
} from '@/lib/services/platform/change-executor-registry'


const createOfferExecutor: ChangeExecutorRegistration['executor'] = async (context, change) => {
  if (change.targetId) {
    throw new DomainChangeExecutionError(
      'COVERAGE_OFFER_TARGET_UNEXPECTED',
      'Coverage offer creation cannot target an existing row.',
    )
  }

  const payload = change.proposedPayload as {
    contact_id?: string
    service_id?: string
    total_amount?: string
    currency?: string
    attributes?: Record<string, unknown>
    commission_per_thousand?: string
    commission_currency?: string
    deal_date?: string
    intent_id?: string
    conversation_id?: string
    source_task_id?: string
    source_task_target_id?: string
    source_coverage_request_id?: string
    supplier_terms?: { details?: string }
  }

  if (!payload.service_id || !payload.total_amount || !payload.currency || !payload.contact_id) {
    throw new DomainChangeExecutionError(
      'OFFER_PAYLOAD_INCOMPLETE',
      'Approved payload must carry contact_id, service_id, total_amount, currency.',
    )
  }

  const offerAmount = parseDecimal(payload.total_amount, { rejectZero: true })
  if (!offerAmount || offerAmount.isNegative()) {
    throw new DomainChangeExecutionError(
      'OFFER_AMOUNT_INVALID',
      'total_amount must be positive.',
    )
  }

  const offerAttrs = readCoverageAttributes(payload.attributes ?? {})
  // A Coverage Task-originated quote is not an arbitrary customer offer. It
  // must still refer to the exact frozen supplier and source Request, under
  // the same account, before an administrator-approved proposal can execute.
  let linkedTarget: { id: string; status: string } | null = null
  if (payload.source_task_id || payload.source_task_target_id || payload.source_coverage_request_id) {
    if (!payload.source_task_id || !payload.source_task_target_id ||
        !payload.source_coverage_request_id || !payload.conversation_id ||
        !payload.supplier_terms?.details) {
      throw new DomainChangeExecutionError('SUPPLIER_OFFER_LINK_INCOMPLETE',
        'Task-linked supplier offer is missing authenticated source references.')
    }
    const checkDb = supabaseAdmin()
    const { data: task, error: taskError } = await checkDb.from('ai_agent_tasks')
      .select('id,task_type,task_context,status')
      .eq('account_id', context.accountId)
      .eq('id', payload.source_task_id).maybeSingle()
    if (taskError) throw taskError
    if (!task || task.task_type !== 'coverage.sourcing' ||
        ['cancelled','failed'].includes(task.status) ||
        (task.task_context as Record<string, unknown>)?.coverageRequestId !== payload.source_coverage_request_id) {
      throw new DomainChangeExecutionError('SUPPLIER_OFFER_TASK_BINDING_INVALID',
        'Proposed supplier offer does not match the source Task/Request.')
    }
    const { data: target, error: targetError } = await checkDb.from('ai_agent_task_targets')
      .select('id,contact_id,conversation_id,status')
      .eq('account_id', context.accountId).eq('task_id', payload.source_task_id)
      .eq('id', payload.source_task_target_id).maybeSingle()
    if (targetError) throw targetError
    if (!target || target.contact_id !== payload.contact_id ||
        target.conversation_id !== payload.conversation_id) {
      throw new DomainChangeExecutionError('SUPPLIER_OFFER_TARGET_BINDING_INVALID',
        'Offer supplier is not the exact Task target.')
    }
    const { data: boundRequest, error: requestError } = await checkDb.from('coverage_requests')
      .select('id,service_id,requested_amount,reserved_amount,fulfilled_amount,currency,status')
      .eq('account_id', context.accountId).eq('id', payload.source_coverage_request_id)
      .maybeSingle()
    if (requestError) throw requestError
    const available = boundRequest
      ? Number(boundRequest.requested_amount) - Number(boundRequest.reserved_amount) -
        Number(boundRequest.fulfilled_amount)
      : 0
    if (!boundRequest || !['active','partially_reserved'].includes(boundRequest.status) ||
        boundRequest.service_id !== payload.service_id ||
        boundRequest.currency !== payload.currency ||
        !Number.isFinite(available) || offerAmount.toNumber() > available) {
      throw new DomainChangeExecutionError('SUPPLIER_OFFER_SOURCE_REQUEST_CHANGED',
        'The linked Coverage Request is no longer active or has insufficient remaining capacity.')
    }
    linkedTarget = { id: target.id, status: target.status }
  }
  const reference = 'CHG-' + change.id.slice(0, 8).toUpperCase()

  const { data: offer, error: offerError } = await supabaseAdmin()
    .from('coverage_offers')
    .upsert(
      {
        account_id: context.accountId,
        service_id: payload.service_id,
        provider_contact_id: payload.contact_id,
        reference_code: reference,
        total_amount: payload.total_amount,
        currency: payload.currency,
        attributes: offerAttrs,
        ...(payload.commission_per_thousand
          ? { commission_per_thousand: payload.commission_per_thousand }
          : {}),
        ...(payload.commission_currency
          ? { commission_currency: payload.commission_currency }
          : {}),
        ...(payload.deal_date ? { deal_date: payload.deal_date } : {}),
        source_change_request_id: change.id,
        ...(payload.source_coverage_request_id && payload.supplier_terms?.details
          ? { notes: `من مهمة توفير تغطية للطلب ${payload.source_coverage_request_id}: ${payload.supplier_terms.details.slice(0, 800)}` }
          : {}),
        status: 'active',
        created_by: context.actorUserId,
      },
      { onConflict: 'source_change_request_id' },
    )
    .select('id, reference_code, commission_amount, commission_currency')
    .single()

  if (offerError) throw offerError

  if (linkedTarget && payload.source_task_id && 
      ['replied', 'awaiting_reply', 'in_progress', 'paused_for_human'].includes(linkedTarget.status)) {
    const { error: targetUpdateError } = await supabaseAdmin()
      .from('ai_agent_task_targets')
      .update({ status: 'completed', completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString() })
      .eq('account_id', context.accountId).eq('task_id', payload.source_task_id)
      .eq('id', linkedTarget.id).in('status',
        ['replied', 'awaiting_reply', 'in_progress', 'paused_for_human'])
    if (targetUpdateError) throw targetUpdateError
  }

  if (payload.intent_id) {
    const { error: intentError } = await supabaseAdmin()
      .from('customer_intents')
      .update({ status: 'fulfilled', matched_service_id: payload.service_id })
      .eq('account_id', context.accountId)
      .eq('id', payload.intent_id)

    if (intentError) throw intentError
  }

  return {
    target_type: change.targetType,
    operation: 'create',
    offer,
    ...(payload.intent_id
      ? {
          customer_notification: {
            intent_id: payload.intent_id,
            event_type: 'approved_and_applied',
            render_from_business_event: true,
          },
        }
      : {}),
  }
}

const createRequestExecutor: ChangeExecutorRegistration['executor'] = async (context, change) => {
  if (change.targetId) {
    throw new DomainChangeExecutionError(
      'COVERAGE_REQUEST_TARGET_UNEXPECTED',
      'Coverage request creation cannot target an existing row.',
    )
  }

  const payload = change.proposedPayload as {
    contact_id?: string
    service_id?: string
    requested_amount?: string
    currency?: string
    attributes?: Record<string, unknown>
    commission_per_thousand?: string
    commission_currency?: string
    deal_date?: string
    expires_at?: string
    intent_id?: string
  }

  if (
    !payload.service_id ||
    !payload.requested_amount ||
    !payload.currency ||
    !payload.contact_id
  ) {
    throw new DomainChangeExecutionError(
      'REQUEST_PAYLOAD_INCOMPLETE',
      'Approved payload must carry contact_id, service_id, requested_amount, currency.',
    )
  }

  const amount = parseDecimal(payload.requested_amount, { rejectZero: true })
  if (!amount || amount.isNegative()) {
    throw new DomainChangeExecutionError(
      'REQUEST_AMOUNT_INVALID',
      'requested_amount must be positive.',
    )
  }

  const requestAttrs = readCoverageAttributes(payload.attributes ?? {})

  const { data: request, error: requestError } = await supabaseAdmin()
    .from('coverage_requests')
    .upsert(
      {
        account_id: context.accountId,
        service_id: payload.service_id,
        requester_contact_id: payload.contact_id,
        requested_amount: payload.requested_amount,
        currency: payload.currency,
        attributes: requestAttrs,
        ...(payload.commission_per_thousand
          ? { commission_per_thousand: payload.commission_per_thousand }
          : {}),
        ...(payload.commission_currency
          ? { commission_currency: payload.commission_currency }
          : {}),
        ...(payload.deal_date ? { deal_date: payload.deal_date } : {}),
        ...(payload.expires_at ? { expires_at: payload.expires_at } : {}),
        source_change_request_id: change.id,
        status: 'active',
        created_by: context.actorUserId,
      },
      { onConflict: 'source_change_request_id' },
    )
    .select('id, requested_amount, currency, status, commission_amount, commission_currency')
    .single()

  if (requestError) throw requestError

  if (payload.intent_id) {
    const { error: intentError } = await supabaseAdmin()
      .from('customer_intents')
      .update({ status: 'fulfilled', matched_service_id: payload.service_id })
      .eq('account_id', context.accountId)
      .eq('id', payload.intent_id)

    if (intentError) throw intentError
  }

  return {
    target_type: change.targetType,
    operation: 'create',
    request,
    ...(payload.intent_id
      ? {
          customer_notification: {
            intent_id: payload.intent_id,
            event_type: 'approved_and_applied',
            render_from_business_event: true,
          },
        }
      : {}),
  }
}

/**
 * A different-route supplier quote is a genuine administrative opportunity,
 * but NOT a matching Coverage Offer. Recording that the admin has reviewed
 * the alternative must never reserve the original Request, create a matching
 * offer, or mark the sourcing Task target completed.
 */
const reviewSupplierCounteroffer: ChangeExecutorRegistration['executor'] = async(context,change)=>{
  const p=change.proposedPayload
  const terms=p.supplier_terms && typeof p.supplier_terms==='object'
    ? p.supplier_terms as Record<string,unknown> : null
  if (change.targetType!=='coverage_supplier_quote' || change.targetId!==null ||
      change.intent!=='create' || !terms || terms.route_match!==false ||
      typeof terms.details!=='string' || terms.details.length<10 || terms.details.length>800 ||
      !p.source_task_id || !p.source_task_target_id || !p.source_coverage_request_id ||
      !p.contact_id || !p.conversation_id || !p.service_id || !p.total_amount ||
      !p.currency || !p.commission_per_thousand) {
    throw new DomainChangeExecutionError('SUPPLIER_REVIEW_INVALID',
      'Counteroffer review requires original source, exact supplier, and explicit different terms.')
  }
  const db=supabaseAdmin()
  const [taskR,targetR,negR,requestR]=await Promise.all([
    db.from('ai_agent_tasks').select('id,task_type,task_context,status')
      .eq('account_id',context.accountId).eq('id',p.source_task_id).maybeSingle(),
    db.from('ai_agent_task_targets').select('id,contact_id,conversation_id,status')
      .eq('account_id',context.accountId).eq('task_id',p.source_task_id)
      .eq('id',p.source_task_target_id).maybeSingle(),
    db.from('ai_agent_coverage_supplier_negotiations')
      .select('stage,route_different,route_confirmed,offered_amount,commission_per_thousand,supplier_details,change_request_id')
      .eq('account_id',context.accountId).eq('task_id',p.source_task_id)
      .eq('task_target_id',p.source_task_target_id).maybeSingle(),
    db.from('coverage_requests').select('id,service_id,currency,attributes')
      .eq('account_id',context.accountId).eq('id',p.source_coverage_request_id).maybeSingle(),
  ])
  if (taskR.error || targetR.error || negR.error || requestR.error) {
    throw taskR.error??targetR.error??negR.error??requestR.error
  }
  const task=taskR.data,target=targetR.data,neg=negR.data,request=requestR.data
  const taskContext=task?.task_context as Record<string,unknown> | null
  if (!task || task.task_type!=='coverage.sourcing' ||
      taskContext?.coverageRequestId!==p.source_coverage_request_id ||
      !target || target.contact_id!==p.contact_id ||
      target.conversation_id!==p.conversation_id ||
      !neg || neg.route_different!==true || neg.route_confirmed!==false ||
      neg.stage!=='submitted' || neg.change_request_id!==change.id ||
      !Number.isFinite(Number(neg.offered_amount)) ||
      !Number.isFinite(Number(neg.commission_per_thousand)) ||
      Number(neg.offered_amount)!==Number(p.total_amount) ||
      Number(neg.commission_per_thousand)!==Number(p.commission_per_thousand) ||
      neg.supplier_details!==terms.details ||
      !request || request.service_id!==p.service_id || request.currency!==p.currency) {
    throw new DomainChangeExecutionError('SUPPLIER_REVIEW_SOURCE_MISMATCH',
      'Alternative terms are not bound to the exact supplier/Task/Request; review was not recorded.')
  }
  if (['replied','awaiting_reply','in_progress'].includes(target.status)) {
    const { error }=await db.from('ai_agent_task_targets')
      .update({status:'paused_for_human',updated_at:new Date().toISOString()})
      .eq('account_id',context.accountId).eq('task_id',p.source_task_id)
      .eq('id',p.source_task_target_id).in('status',['replied','awaiting_reply','in_progress'])
    if (error) throw error
  }
  // Deliberately no Coverage Offer mutation, no reservations and no
  // customer_notification "approved" event: terms still need human work.
  return {
    target_type:'coverage_supplier_quote',operation:'review_acknowledged',
    requires_manual_followup:true, created_offer:false,
    source_request_id:p.source_coverage_request_id,
    supplier_task_id:p.source_task_id,supplier_target_id:p.source_task_target_id,
  }
}

export const COVERAGE_CHANGE_EXECUTORS: readonly ChangeExecutorRegistration[] = [
  { actionKey:'coverage.supplier_counteroffer.review',actionVersion:1,
    executor:reviewSupplierCounteroffer },
  {
    actionKey: 'coverage.offer.create',
    actionVersion: 1,
    executor: createOfferExecutor,
  },
  {
    actionKey: 'coverage.request.create',
    actionVersion: 1,
    executor: createRequestExecutor,
  },
]
