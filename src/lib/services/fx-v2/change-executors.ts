import {
  decideFxTradeRequest,
  FxServiceError,
  publishFxRateVersion,
} from './service'
import {
  DomainChangeExecutionError,
  type ChangeExecutorRegistration,
} from '@/lib/services/platform/change-executor-registry'

const publishRateExecutor: ChangeExecutorRegistration['executor'] = async (context, change) => {
  if (!change.targetId) {
    throw new DomainChangeExecutionError(
      'FX_RATE_CHANGE_TARGET_REQUIRED',
      'Approved FX rate proposal is missing its target pair.',
    )
  }

  const payload = change.proposedPayload as {
    expected_lock_version?: number
    business_buy_rate?: string
    business_sell_rate?: string
    notes_internal?: string | null
  }

  if (
    !Number.isSafeInteger(payload.expected_lock_version) ||
    Number(payload.expected_lock_version) < 0 ||
    !payload.business_buy_rate ||
    !payload.business_sell_rate
  ) {
    throw new DomainChangeExecutionError(
      'FX_RATE_CHANGE_PAYLOAD_INCOMPLETE',
      'Approved FX rate proposal is missing lock version or buy/sell rates.',
    )
  }

  try {
    const published = await publishFxRateVersion({
      accountId: context.accountId,
      pairId: change.targetId,
      expectedLockVersion: Number(payload.expected_lock_version),
      businessBuyRate: payload.business_buy_rate,
      businessSellRate: payload.business_sell_rate,
      source: 'admin_agent',
      sourceChangeRequestId: change.id,
      notesInternal: payload.notes_internal ?? null,
      actorUserId: context.actorUserId,
    })

    return {
      target_type: change.targetType,
      target_id: change.targetId,
      operation: 'publish_fx_v2_rate_version',
      version_id: published.versionId,
      version_number: published.versionNumber,
      lock_version: published.lockVersion,
      idempotent: published.idempotent,
    }
  } catch (error) {
    if (error instanceof FxServiceError) {
      throw new DomainChangeExecutionError(error.code, error.message, error.status)
    }
    throw error
  }
}

const decideTradeExecutor: ChangeExecutorRegistration['executor'] = async (context, change) => {
  if (!change.targetId) {
    throw new DomainChangeExecutionError(
      'FX_TRADE_DECISION_TARGET_REQUIRED',
      'Approved FX trade decision is missing its target request.',
    )
  }

  const payload = change.proposedPayload as {
    expected_status?: string
    decision?: string
    note?: string | null
    rate_version_id?: string
  }

  if (
    payload.expected_status !== 'pending_admin' ||
    (payload.decision !== 'approve' && payload.decision !== 'reject')
  ) {
    throw new DomainChangeExecutionError(
      'FX_TRADE_DECISION_PAYLOAD_INCOMPLETE',
      'Approved FX trade decision must target pending_admin and choose approve or reject.',
    )
  }

  try {
    const decided = await decideFxTradeRequest({
      accountId: context.accountId,
      requestId: change.targetId,
      expectedStatus: 'pending_admin',
      decision: payload.decision,
      changeRequestId: change.id,
      note: payload.note ?? null,
      actorUserId: context.actorUserId,
    })

    return {
      target_type: change.targetType,
      target_id: change.targetId,
      operation: 'decide_fx_v2_trade_request',
      decision: payload.decision,
      rate_version_id: payload.rate_version_id ?? null,
      request_status: decided.status,
      idempotent: decided.idempotent,
    }
  } catch (error) {
    if (error instanceof FxServiceError) {
      throw new DomainChangeExecutionError(error.code, error.message, error.status)
    }
    throw error
  }
}

export const FX_V2_CHANGE_EXECUTORS: readonly ChangeExecutorRegistration[] = [
  {
    actionKey: 'exchange_rates.pair.publish',
    actionVersion: 1,
    executor: publishRateExecutor,
  },
  {
    actionKey: 'exchange_rates.trade.decide',
    actionVersion: 1,
    executor: decideTradeExecutor,
  },
]
