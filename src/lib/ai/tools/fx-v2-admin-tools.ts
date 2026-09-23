import {
  createChangeRequest,
  findChangeRequestByIdempotencyKey,
} from '@/lib/ai/runtime/change-requests-service'
import {
  getCurrentFxRateByPair,
  listFxPairs,
  type FxPair,
} from '@/lib/services/fx-v2/service'
import {
  listFxTradeRequests,
  type FxTradeRequestStatus,
} from '@/lib/services/fx-v2/dashboard'
import type { ToolContext, ToolResult } from './executors'

function requireAdmin(ctx: ToolContext): ToolResult<never> | null {
  if (ctx.plane !== 'admin' || !ctx.trustedAdminIdentityId) {
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'ADMIN_CONTEXT_REQUIRED',
      message: 'Verified admin context is required.',
    }
  }
  return null
}

function positiveDecimal(value: unknown): string | null {
  const text = String(value ?? '').trim()
  if (!text) return null
  const n = Number(text)
  return Number.isFinite(n) && n > 0 ? text : null
}

async function pairById(accountId: string, pairId: string): Promise<FxPair | null> {
  const pairs = await listFxPairs(accountId, { includeArchived: true })
  return pairs.find((pair) => pair.id === pairId) ?? null
}

export async function executeFxV2AdminListPairs(
  ctx: ToolContext,
  args: { status?: 'active' | 'archived'; limit?: number },
): Promise<ToolResult<unknown>> {
  const denied = requireAdmin(ctx)
  if (denied) return denied

  try {
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? 50), 1), 100)
    const pairs = await listFxPairs(ctx.accountId, { includeArchived: true })
    const filtered = args.status ? pairs.filter((pair) => pair.status === args.status) : pairs
    const rows = await Promise.all(
      filtered.slice(0, limit).map(async (pair) => {
        const current = await getCurrentFxRateByPair(ctx.accountId, pair)
        return {
          pair_id: pair.id,
          base_currency: pair.base.code,
          quote_currency: pair.quote.code,
          status: pair.status,
          lock_version: pair.lockVersion,
          current_rate: current
            ? {
                rate_version_id: current.rateVersionId,
                version_number: current.versionNumber,
                business_buy_rate: current.businessBuyRate,
                business_sell_rate: current.businessSellRate,
                source: current.source,
                published_at: current.publishedAt,
              }
            : null,
          updated_at: pair.updatedAt,
        }
      }),
    )
    return { ok: true, data: rows, safe_to_show: false }
  } catch (err) {
    console.error('[tool] FX V2 admin pair read failed:', err)
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'FX_ADMIN_PAIR_READ_FAILED',
      message: 'Could not read FX pairs.',
    }
  }
}

export async function executeFxV2ProposePairChange(
  ctx: ToolContext,
  args: {
    pair_id: string
    expected_lock_version: number
    business_buy_rate: string
    business_sell_rate: string
    notes_internal?: string | null
  },
): Promise<ToolResult<unknown>> {
  const denied = requireAdmin(ctx)
  if (denied) return denied

  const buy = positiveDecimal(args.business_buy_rate)
  const sell = positiveDecimal(args.business_sell_rate)
  if (
    !args.pair_id ||
    !Number.isSafeInteger(args.expected_lock_version) ||
    args.expected_lock_version < 0 ||
    !buy ||
    !sell
  ) {
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'INVALID_FX_RATE_PROPOSAL',
      message: 'pair_id, expected_lock_version and positive buy/sell rates are required.',
    }
  }

  try {
    const pair = await pairById(ctx.accountId, args.pair_id)
    if (!pair || pair.status !== 'active') {
      return {
        ok: false,
        data: null,
        safe_to_show: false,
        code: 'FX_PAIR_NOT_ACTIVE',
        message: 'FX pair was not found or is not active.',
      }
    }
    if (pair.lockVersion !== args.expected_lock_version) {
      return {
        ok: false,
        data: null,
        safe_to_show: false,
        code: 'FX_PAIR_VERSION_CONFLICT',
        message: 'The FX pair changed after it was read. Read the pair again before proposing a new rate.',
      }
    }

    const cr = await createChangeRequest({
      accountId: ctx.accountId,
      actionKey: 'exchange_rates.pair.publish',
      actionVersion: 1,
      targetType: 'fx_rate_pair',
      targetId: pair.id,
      intent: 'update',
      proposedPayload: {
        expected_lock_version: pair.lockVersion,
        business_buy_rate: buy,
        business_sell_rate: sell,
        notes_internal: args.notes_internal?.slice(0, 1000) ?? null,
      },
      idempotencyKey: [
        'fx-rate-v2',
        pair.id,
        String(pair.lockVersion),
        buy,
        sell,
        args.notes_internal?.slice(0, 200) ?? '',
      ].join(':'),
      summary: `تغيير سعر ${pair.base.code}/${pair.quote.code}: شراء المؤسسة ${buy} / بيع المؤسسة ${sell}`,
      actorUserId: ctx.actorUserId,
    })

    return {
      ok: true,
      data: {
        pair: {
          pair_id: pair.id,
          base_currency: pair.base.code,
          quote_currency: pair.quote.code,
          expected_lock_version: pair.lockVersion,
        },
        proposed_rate: {
          business_buy_rate: buy,
          business_sell_rate: sell,
        },
        change_request: {
          id: cr.id,
          code: cr.code,
          confirmation_code: cr.confirmationCode,
          status: cr.status,
        },
      },
      safe_to_show: false,
    }
  } catch (err) {
    console.error('[tool] FX V2 pair proposal failed:', err)
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'FX_RATE_CHANGE_PROPOSAL_FAILED',
      message: 'Could not create the FX rate change proposal.',
    }
  }
}

const TRADE_STATUSES = new Set<FxTradeRequestStatus>([
  'pending_admin',
  'approved_for_contact',
  'rejected',
  'completed',
  'cancelled',
])

export async function executeFxV2AdminListTradeRequests(
  ctx: ToolContext,
  args: { status?: FxTradeRequestStatus; limit?: number },
): Promise<ToolResult<unknown>> {
  const denied = requireAdmin(ctx)
  if (denied) return denied
  if (args.status && !TRADE_STATUSES.has(args.status)) {
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'INVALID_TRADE_STATUS',
      message: 'Invalid FX trade request status.',
    }
  }

  try {
    const rows = await listFxTradeRequests(ctx.accountId, {
      status: args.status ?? null,
      limit: Math.min(Math.max(Math.trunc(args.limit ?? 50), 1), 100),
    })
    return {
      ok: true,
      data: rows.map((row) => ({
        request_id: row.id,
        code: row.code,
        pair_id: row.pair.id,
        base_currency: row.pair.base.code,
        quote_currency: row.pair.quote.code,
        side: row.side,
        amount_basis: row.amountBasis,
        requested_amount: row.requestedAmount,
        rate_version_id: row.rateVersionId,
        effective_rate: row.effectiveRate,
        base_amount: row.baseAmount,
        quote_amount: row.quoteAmount,
        status: row.status,
        contact_id: row.contactId,
        conversation_id: row.conversationId,
        created_at: row.createdAt,
      })),
      safe_to_show: false,
    }
  } catch (err) {
    console.error('[tool] FX V2 admin trade read failed:', err)
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'FX_ADMIN_TRADE_READ_FAILED',
      message: 'Could not read FX trade requests.',
    }
  }
}

export async function executeFxV2ProposeTradeDecision(
  ctx: ToolContext,
  args: {
    request_id: string
    decision: 'approve' | 'reject'
    note?: string | null
  },
): Promise<ToolResult<unknown>> {
  const denied = requireAdmin(ctx)
  if (denied) return denied
  if (!args.request_id || (args.decision !== 'approve' && args.decision !== 'reject')) {
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'INVALID_TRADE_DECISION',
      message: 'request_id and decision=approve|reject are required.',
    }
  }

  try {
    const rows = await listFxTradeRequests(ctx.accountId, {
      status: 'pending_admin',
      limit: 250,
    })
    const request = rows.find((row) => row.id === args.request_id)
    if (!request) {
      return {
        ok: false,
        data: null,
        safe_to_show: false,
        code: 'FX_TRADE_NOT_PENDING',
        message: 'FX trade request was not found in pending_admin state.',
      }
    }

    const reviewIdempotencyKey = `fx-trade-review:${request.id}:pending_admin`
    const existingReview = await findChangeRequestByIdempotencyKey(
      ctx.accountId,
      reviewIdempotencyKey,
    )

    if (args.decision === 'approve' && existingReview?.status === 'pending') {
      return {
        ok: true,
        data: {
          trade_request: {
            request_id: request.id,
            code: request.code,
            pair: `${request.pair.base.code}/${request.pair.quote.code}`,
            status: request.status,
            rate_version_id: request.rateVersionId,
            effective_rate: request.effectiveRate,
            base_amount: request.baseAmount,
            quote_amount: request.quoteAmount,
          },
          proposed_decision: args.decision,
          change_request: {
            id: existingReview.id,
            code: existingReview.code,
            confirmation_code: null,
            status: existingReview.status,
            reused: true,
          },
        },
        safe_to_show: false,
      }
    }

    const cr = await createChangeRequest({
      accountId: ctx.accountId,
      actionKey: 'exchange_rates.trade.decide',
      actionVersion: 1,
      targetType: 'fx_trade_request',
      targetId: request.id,
      intent: 'update',
      proposedPayload: {
        expected_status: 'pending_admin',
        decision: args.decision,
        note: args.note?.slice(0, 1000) ?? null,
        rate_version_id: request.rateVersionId,
      },
      idempotencyKey: [
        'fx-trade-decision',
        request.id,
        'pending_admin',
        args.decision,
        args.note?.slice(0, 200) ?? '',
      ].join(':'),
      summary: `قرار طلب صرف #${request.code}: ${args.decision === 'approve' ? 'قبول للتواصل' : 'رفض'}`,
      actorUserId: ctx.actorUserId,
    })

    return {
      ok: true,
      data: {
        trade_request: {
          request_id: request.id,
          code: request.code,
          pair: `${request.pair.base.code}/${request.pair.quote.code}`,
          status: request.status,
          rate_version_id: request.rateVersionId,
          effective_rate: request.effectiveRate,
          base_amount: request.baseAmount,
          quote_amount: request.quoteAmount,
        },
        proposed_decision: args.decision,
        change_request: {
          id: cr.id,
          code: cr.code,
          confirmation_code: cr.confirmationCode,
          status: cr.status,
          reused: false,
        },
      },
      safe_to_show: false,
    }
  } catch (err) {
    console.error('[tool] FX V2 trade decision proposal failed:', err)
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'FX_TRADE_DECISION_PROPOSAL_FAILED',
      message: 'Could not create the FX trade decision proposal.',
    }
  }
}
