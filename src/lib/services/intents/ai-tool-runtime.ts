import { supabaseAdmin } from '@/lib/ai/admin-client'
import { createChangeRequest } from '@/lib/ai/runtime/change-requests-service'
import type { ModelToolExecutorRegistration } from '@/lib/ai/tools/platform/runtime-contracts'
import type { ToolContext, ToolResult } from '@/lib/ai/tools/executors'
import { listIntents, recordIntent } from './intents-service'

interface IntentsRecordArgs {
  contact_id: string
  conversation_id?: string
  direction: 'offer' | 'request'
  service_hint: string
  summary?: string
  attributes?: Record<string, unknown>
  escalate_to_admin?: boolean
}

async function executeIntentsRecord(
  ctx: ToolContext,
  args: IntentsRecordArgs,
): Promise<ToolResult<unknown>> {
  if (!args.contact_id || !args.service_hint?.trim()) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message: 'contact_id and service_hint are required.',
    }
  }
  if (args.direction !== 'offer' && args.direction !== 'request') {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message: 'direction must be "offer" or "request".',
    }
  }

  try {
    const result = await recordIntent({
      accountId: ctx.accountId,
      contactId:
        ctx.plane === 'customer' && ctx.contactId
          ? ctx.contactId
          : args.contact_id,
      conversationId:
        ctx.plane === 'customer'
          ? ctx.conversationId
          : args.conversation_id ?? null,
      direction: args.direction,
      serviceHint: args.service_hint,
      summary: args.summary ?? null,
      attributes: args.attributes ?? {},
      // Generic intent recording is a review handoff. The historical
      // service_intent/create change request carries no executable decision.
      escalateToAdmin: false,
      actorUserId: ctx.actorUserId,
    })

    if (args.escalate_to_admin) {
      const { error } = await supabaseAdmin()
        .from('customer_intents')
        .update({
          status: 'forwarded_to_admin',
          ...(ctx.sourceMessageId
            ? { source_message_id: ctx.sourceMessageId }
            : {}),
        })
        .eq('account_id', ctx.accountId)
        .eq('id', result.intentId)
      if (error) throw error

      return {
        ok: true,
        data: {
          ...result,
          status: 'forwarded_to_admin',
          review_required: true,
        },
        safe_to_show: true,
      }
    }

    return { ok: true, data: result, safe_to_show: true }
  } catch (error) {
    const code =
      (error as { code?: string }).code ?? 'INTENT_RECORD_FAILED'
    return {
      ok: false,
      data: null,
      safe_to_show: code !== 'INTENT_CREATE_FAILED',
      code,
      message:
        (error as { message?: string }).message ??
        'Could not record the observation.',
    }
  }
}

interface IntentsSearchArgs {
  contact_id?: string
  status?: string
  q?: string
  limit?: number
}

async function executeIntentsSearch(
  ctx: ToolContext,
  args: IntentsSearchArgs,
): Promise<ToolResult<unknown>> {
  const allowedStatuses = new Set([
    'new',
    'clarifying',
    'forwarded_to_admin',
    'fulfilled',
    'rejected',
    'matched',
  ])
  if (args.status && !allowedStatuses.has(args.status)) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message: `status must be one of: ${[
        ...allowedStatuses,
      ].join(', ')}.`,
    }
  }

  try {
    const intents = await listIntents(ctx.accountId, {
      contactId: args.contact_id,
      status: args.status,
      q: args.q,
      limit: Math.min(args.limit ?? 20, 100),
    })
    return {
      ok: true,
      data: intents.map((intent) => ({
        intent_id: intent.id,
        contact_id: intent.contact_id,
        conversation_id: intent.conversation_id,
        direction: intent.direction,
        service_hint: intent.service_hint,
        summary: intent.summary,
        status: intent.status,
        attributes: intent.attributes,
        matched_service_id: intent.matched_service_id,
        created_at: intent.created_at,
      })),
      safe_to_show: true,
    }
  } catch (error) {
    console.error('[tool] intents.search failed:', error)
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'INTENT_SEARCH_FAILED',
      message: 'Could not search intents.',
    }
  }
}

interface IntentDecisionArgs {
  intent_id: string
  decision: 'fulfilled' | 'rejected' | 'matched' | 'clarifying'
  matched_service_id?: string
  reason?: string
}

async function executeIntentProposeDecision(
  ctx: ToolContext,
  args: IntentDecisionArgs,
): Promise<ToolResult<unknown>> {
  const allowed = new Set(['fulfilled', 'rejected', 'matched', 'clarifying'])
  if (!args.intent_id || !allowed.has(args.decision)) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'INVALID_INPUT',
      message: 'intent_id and a valid decision are required.',
    }
  }
  if (args.decision === 'matched' && !args.matched_service_id) {
    return {
      ok: false,
      data: null,
      safe_to_show: true,
      code: 'MATCHED_SERVICE_REQUIRED',
      message: 'matched_service_id is required when decision=matched.',
    }
  }

  try {
    const { data: intent, error } = await supabaseAdmin()
      .from('customer_intents')
      .select('id, service_hint, status')
      .eq('account_id', ctx.accountId)
      .eq('id', args.intent_id)
      .maybeSingle()
    if (error) throw error
    if (!intent) {
      return {
        ok: false,
        data: null,
        safe_to_show: true,
        code: 'INTENT_NOT_FOUND',
        message: 'Customer intent was not found.',
      }
    }

    const change = await createChangeRequest({
      accountId: ctx.accountId,
      targetType: 'service_intent',
      targetId: args.intent_id,
      intent: 'update',
      proposedPayload: {
        decision: args.decision,
        ...(args.matched_service_id
          ? { matched_service_id: args.matched_service_id }
          : {}),
        ...(args.reason ? { reason: args.reason } : {}),
      },
      idempotencyKey:
        `intent-decision:${args.intent_id}:${args.decision}:${args.matched_service_id ?? ''}`,
      summary:
        `قرار إداري للحالة: ${String(intent.service_hint)} → ${args.decision}`,
      actorUserId: ctx.actorUserId,
    })

    return {
      ok: true,
      data: {
        change_request: {
          id: change.id,
          code: change.code,
          confirmation_code: change.confirmationCode,
          status: change.status,
        },
      },
      safe_to_show: false,
    }
  } catch (error) {
    console.error('[tool] intent decision proposal failed:', error)
    return {
      ok: false,
      data: null,
      safe_to_show: false,
      code: 'INTENT_DECISION_PROPOSAL_FAILED',
      message: 'Could not create the intent decision proposal.',
    }
  }
}

export const INTENTS_MODEL_TOOL_EXECUTORS: readonly ModelToolExecutorRegistration[] = [
  {
    key: 'intents.record',
    version: 1,
    executor: (ctx, args) => executeIntentsRecord(ctx, args as never),
  },
  {
    key: 'intents.search',
    version: 1,
    executor: (ctx, args) => executeIntentsSearch(ctx, args as never),
  },
  {
    key: 'intents.propose_decision',
    version: 1,
    executor: (ctx, args) => executeIntentProposeDecision(ctx, args as never),
  },
]
