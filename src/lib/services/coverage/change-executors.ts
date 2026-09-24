import { supabaseAdmin } from '@/lib/ai/admin-client'
import { parseDecimal } from '@/lib/services/pricing/decimal'
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
        status: 'active',
        created_by: context.actorUserId,
      },
      { onConflict: 'source_change_request_id' },
    )
    .select('id, reference_code, commission_amount, commission_currency')
    .single()

  if (offerError) throw offerError

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

export const COVERAGE_CHANGE_EXECUTORS: readonly ChangeExecutorRegistration[] = [
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
