import { supabaseAdmin } from '@/lib/ai/admin-client'
import { createChangeRequest, listChangeRequests } from '@/lib/ai/runtime/change-requests-service'
import { readCoverageAttributes } from '@/lib/services/coverage/attributes'
import { parseDecimal } from '@/lib/services/pricing/decimal'
import type { ToolContext, ToolResult } from './executors'

interface CoverageProposalArgs {
  service_id: string
  total_amount: string
  currency: string
  attributes?: Record<string, unknown>
  commission_per_thousand?: string
  commission_currency?: string
  deal_date?: string
}

export interface CoverageRequestProposalArgs {
  service_id: string
  requested_amount: string
  currency: string
  attributes?: Record<string, unknown>
  commission_per_thousand?: string
  commission_currency?: string
  deal_date?: string
  expires_at?: string
}

function customerBinding(ctx: ToolContext):
  | { ok: true; contactId: string; conversationId: string; sourceMessageId: string }
  | { ok: false; result: ToolResult<never> } {
  if (ctx.plane !== 'customer') {
    return {
      ok: false,
      result: { ok: false, data: null, safe_to_show: true, code: 'CUSTOMER_CONTEXT_REQUIRED', message: 'This proposal must originate from a customer conversation.' },
    }
  }
  if (!ctx.contactId || !ctx.conversationId || !ctx.sourceMessageId) {
    return {
      ok: false,
      result: { ok: false, data: null, safe_to_show: false, code: 'CUSTOMER_CONTEXT_MISSING', message: 'The runtime did not bind the proposal to its source message.' },
    }
  }
  return { ok: true, contactId: ctx.contactId, conversationId: ctx.conversationId, sourceMessageId: ctx.sourceMessageId }
}

function validateAmountCurrency(amount: string, currency: string): ToolResult<never> | null {
  if (!parseDecimal(amount, { rejectZero: true })) {
    return { ok: false, data: null, safe_to_show: true, code: 'INVALID_AMOUNT', message: 'Amount must be a positive number.' }
  }
  if (!/^[A-Z_]{3,8}$/.test(currency)) {
    return { ok: false, data: null, safe_to_show: true, code: 'INVALID_CURRENCY', message: 'currency must be a configured uppercase currency code.' }
  }
  return null
}

function validateCommission(rate?: string, currency?: string): ToolResult<never> | null {
  if (rate === undefined) return null
  if (!parseDecimal(rate) || !currency) {
    return { ok: false, data: null, safe_to_show: true, code: 'INVALID_COMMISSION', message: 'commission_per_thousand must be non-negative and commission_currency is required.' }
  }
  return null
}

async function createBoundIntent(input: {
  ctx: ToolContext
  contactId: string
  conversationId: string
  sourceMessageId: string
  direction: 'offer' | 'request'
  serviceHint: string
  summary: string
  attributes: Record<string, unknown>
}): Promise<string> {
  const db = supabaseAdmin()
  const idem = `msg:${input.sourceMessageId}:${input.direction}:${input.serviceHint}`.slice(0, 220)
  const { data, error } = await db.rpc('create_customer_intent', {
    p_account_id: input.ctx.accountId,
    p_contact_id: input.contactId,
    p_conversation_id: input.conversationId,
    p_direction: input.direction,
    p_service_hint: input.serviceHint,
    p_summary: input.summary,
    p_attributes: input.attributes,
    p_idempotency_key: idem,
    p_actor_user_id: input.ctx.actorUserId,
  })
  if (error || !data) throw error ?? new Error('INTENT_CREATE_FAILED')
  const intentId = data as string
  const { error: sourceErr } = await db.from('customer_intents').update({ source_message_id: input.sourceMessageId }).eq('account_id', input.ctx.accountId).eq('id', intentId)
  if (sourceErr) throw sourceErr
  return intentId
}

async function linkIntentToChangeRequest(input: { accountId: string; intentId: string; changeRequestId: string }): Promise<void> {
  const { error } = await supabaseAdmin().from('customer_intents').update({ status: 'forwarded_to_admin', change_request_id: input.changeRequestId }).eq('account_id', input.accountId).eq('id', input.intentId)
  if (error) throw error
}

export async function executeCoverageProposeOfferIntegrated(ctx: ToolContext, args: CoverageProposalArgs): Promise<ToolResult<unknown>> {
  const bound = customerBinding(ctx)
  if (!bound.ok) return bound.result
  if (!args.service_id || !args.total_amount || !args.currency) {
    return { ok: false, data: null, safe_to_show: true, code: 'INVALID_INPUT', message: 'service_id, total_amount, and currency are required.' }
  }
  const invalid = validateAmountCurrency(args.total_amount, args.currency) ?? validateCommission(args.commission_per_thousand, args.commission_currency)
  if (invalid) return invalid
  try {
    const attrs = readCoverageAttributes(args.attributes ?? {})
    const intentId = await createBoundIntent({
      ctx, ...bound, direction: 'offer', serviceHint: `coverage:${args.service_id}`,
      summary: `Customer coverage offer: ${args.total_amount} ${args.currency}`,
      attributes: { service_id: args.service_id, total_amount: args.total_amount, currency: args.currency, ...attrs,
        ...(args.commission_per_thousand !== undefined ? { commission_per_thousand: args.commission_per_thousand, commission_currency: args.commission_currency } : {}),
        ...(args.deal_date ? { deal_date: args.deal_date } : {}) },
    })
    const cr = await createChangeRequest({
      accountId: ctx.accountId, actionKey: 'coverage.offer.create', actionVersion: 1,
      targetType: 'coverage_offer', targetId: null, intent: 'create',
      proposedPayload: { contact_id: bound.contactId, conversation_id: bound.conversationId, source_message_id: bound.sourceMessageId, intent_id: intentId,
        service_id: args.service_id, total_amount: args.total_amount, currency: args.currency, attributes: attrs,
        ...(args.commission_per_thousand !== undefined ? { commission_per_thousand: args.commission_per_thousand, commission_currency: args.commission_currency } : {}),
        ...(args.deal_date ? { deal_date: args.deal_date } : {}) },
      idempotencyKey: `coverage-offer:${bound.sourceMessageId}:${args.service_id}`,
      summary: `اعتماد عرض تغطية ${args.total_amount} ${args.currency}`, actorUserId: ctx.actorUserId,
    })
    await linkIntentToChangeRequest({ accountId: ctx.accountId, intentId, changeRequestId: cr.id })
    return { ok: true, data: { intent: { intent_id: intentId, status: 'forwarded_to_admin' }, change_request: { id: cr.id, code: cr.code, confirmation_code: cr.confirmationCode, status: cr.status } }, safe_to_show: true }
  } catch (err) {
    console.error('[tool] integrated coverage offer proposal failed:', err)
    return { ok: false, data: null, safe_to_show: false, code: 'COVERAGE_OFFER_PROPOSAL_FAILED', message: 'Could not forward the coverage offer for approval.' }
  }
}

export async function executeCoverageProposeRequest(ctx: ToolContext, args: CoverageRequestProposalArgs): Promise<ToolResult<unknown>> {
  const bound = customerBinding(ctx)
  if (!bound.ok) return bound.result
  if (!args.service_id || !args.requested_amount || !args.currency) {
    return { ok: false, data: null, safe_to_show: true, code: 'INVALID_INPUT', message: 'service_id, requested_amount, and currency are required.' }
  }
  const invalid = validateAmountCurrency(args.requested_amount, args.currency) ?? validateCommission(args.commission_per_thousand, args.commission_currency)
  if (invalid) return invalid
  try {
    const attrs = readCoverageAttributes(args.attributes ?? {})
    const intentId = await createBoundIntent({
      ctx, ...bound, direction: 'request', serviceHint: `coverage:${args.service_id}`,
      summary: `Customer coverage request: ${args.requested_amount} ${args.currency}`,
      attributes: { service_id: args.service_id, requested_amount: args.requested_amount, currency: args.currency, ...attrs,
        ...(args.commission_per_thousand !== undefined ? { commission_per_thousand: args.commission_per_thousand, commission_currency: args.commission_currency } : {}),
        ...(args.deal_date ? { deal_date: args.deal_date } : {}), ...(args.expires_at ? { expires_at: args.expires_at } : {}) },
    })
    const cr = await createChangeRequest({
      accountId: ctx.accountId, actionKey: 'coverage.request.create', actionVersion: 1,
      targetType: 'coverage_request', targetId: null, intent: 'create',
      proposedPayload: { contact_id: bound.contactId, conversation_id: bound.conversationId, source_message_id: bound.sourceMessageId, intent_id: intentId,
        service_id: args.service_id, requested_amount: args.requested_amount, currency: args.currency, attributes: attrs,
        ...(args.commission_per_thousand !== undefined ? { commission_per_thousand: args.commission_per_thousand, commission_currency: args.commission_currency } : {}),
        ...(args.deal_date ? { deal_date: args.deal_date } : {}), ...(args.expires_at ? { expires_at: args.expires_at } : {}) },
      idempotencyKey: `coverage-request:${bound.sourceMessageId}:${args.service_id}`,
      summary: `اعتماد طلب تغطية ${args.requested_amount} ${args.currency}`, actorUserId: ctx.actorUserId,
    })
    await linkIntentToChangeRequest({ accountId: ctx.accountId, intentId, changeRequestId: cr.id })
    return { ok: true, data: { intent: { intent_id: intentId, status: 'forwarded_to_admin' }, change_request: { id: cr.id, code: cr.code, confirmation_code: cr.confirmationCode, status: cr.status } }, safe_to_show: true }
  } catch (err) {
    console.error('[tool] integrated coverage request proposal failed:', err)
    return { ok: false, data: null, safe_to_show: false, code: 'COVERAGE_REQUEST_PROPOSAL_FAILED', message: 'Could not forward the coverage request for approval.' }
  }
}

export async function executeCoverageAdminListOffers(
  ctx: ToolContext,
  args: { status?: string; limit?: number },
): Promise<ToolResult<unknown>> {
  try {
    let q = supabaseAdmin()
      .from('coverage_offers')
      .select('id, reference_code, service_id, provider_contact_id, total_amount, reserved_amount, fulfilled_amount, currency, attributes, commission_per_thousand, commission_currency, provider_cost, provider_cost_currency, deal_date, expires_at, status, created_at')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .limit(Math.min(args.limit ?? 20, 100))
    if (args.status) q = q.eq('status', args.status)
    const { data, error } = await q
    if (error) throw error
    return { ok: true, data: data ?? [], safe_to_show: false }
  } catch (err) {
    console.error('[tool] admin coverage offers failed:', err)
    return { ok: false, data: null, safe_to_show: false, code: 'COVERAGE_ADMIN_READ_FAILED', message: 'Could not read coverage offers.' }
  }
}

export async function executeCoverageAdminListRequests(
  ctx: ToolContext,
  args: { status?: string; limit?: number },
): Promise<ToolResult<unknown>> {
  try {
    let q = supabaseAdmin()
      .from('coverage_requests')
      .select('id, service_id, requester_contact_id, requested_amount, reserved_amount, fulfilled_amount, currency, attributes, quote_snapshot, commission_per_thousand, commission_currency, deal_date, expires_at, priority, notes, status, created_at')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false })
      .limit(Math.min(args.limit ?? 20, 100))
    if (args.status) q = q.eq('status', args.status)
    const { data, error } = await q
    if (error) throw error
    return { ok: true, data: data ?? [], safe_to_show: false }
  } catch (err) {
    console.error('[tool] admin coverage requests failed:', err)
    return { ok: false, data: null, safe_to_show: false, code: 'COVERAGE_ADMIN_READ_FAILED', message: 'Could not read coverage requests.' }
  }
}

export async function executeChangeRequestsListPending(
  ctx: ToolContext,
  args: { limit?: number },
): Promise<ToolResult<unknown>> {
  try {
    const rows = await listChangeRequests(ctx.accountId, {
      status: 'pending',
      limit: Math.min(args.limit ?? 20, 100),
    })
    return {
      ok: true,
      data: rows.map((row) => ({
        id: row.id,
        code: row.code,
        target_type: row.target_type,
        target_id: row.target_id,
        intent: row.intent,
        summary: row.summary,
        proposed_payload: row.proposed_payload,
        created_at: row.created_at,
        expires_at: row.expires_at,
      })),
      safe_to_show: false,
    }
  } catch (err) {
    console.error('[tool] pending changes read failed:', err)
    return { ok: false, data: null, safe_to_show: false, code: 'CHANGE_REQUEST_READ_FAILED', message: 'Could not read pending changes.' }
  }
}

export { executeServiceProposeUpdate } from '@/lib/services/service-catalog/ai-tool-runtime'
export { executePricingRuleProposeServicePrice } from '@/lib/services/pricing-rules/ai-tool-runtime'
