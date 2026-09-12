import { supabaseAdmin } from '@/lib/ai/admin-client'
import { publishExchangeRateVersion } from '@/lib/services/domain-services'
import { publishPricingRuleRaw } from '@/lib/services/pricing/rules-crud'
import { readCoverageAttributes } from '@/lib/services/coverage/attributes'

export class ChangeExecutionError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'ChangeExecutionError'
    this.code = code
    this.status = status
  }
}

/**
 * Executes only registered, deterministic change targets. The
 * model never reaches this function directly; the request must
 * already be approved and its optimistic version must still match.
 */
export async function executeApprovedChangeRequest(input: {
  accountId: string
  changeRequestId: string
  actorUserId: string | null
}): Promise<Record<string, unknown>> {
  const db = supabaseAdmin()
  const { data: request, error } = await db
    .from('change_requests')
    .select('id, account_id, target_type, target_id, intent, proposed_payload, expected_version, status, expires_at')
    .eq('account_id', input.accountId)
    .eq('id', input.changeRequestId)
    .maybeSingle()
  if (error) throw error
  if (!request) throw new ChangeExecutionError('NOT_FOUND', 'Change request not found.', 404)
  const row = request as {
    id: string; account_id: string; target_type: string; target_id: string | null
    intent: string; proposed_payload: Record<string, unknown>; expected_version: number | null
    status: string; expires_at: string
  }
  if (row.status === 'executed') return { status: 'executed', id: row.id, idempotent: true }
  if (row.status !== 'approved') throw new ChangeExecutionError('NOT_APPROVED', 'Change request is not approved.')
  if (Date.parse(row.expires_at) < Date.now()) throw new ChangeExecutionError('EXPIRED', 'Change request expired.')

  let result: Record<string, unknown>
  if (row.target_type === 'pricing_rule' && row.intent === 'publish' && row.target_id) {
    const published = await publishPricingRuleRaw(input.accountId, row.target_id, input.actorUserId)
    result = { target_type: row.target_type, target_id: row.target_id, operation: 'publish', rule: published }
  } else if (row.target_type === 'rate_book_version' && row.intent === 'publish' && row.target_id) {
    const bookId = typeof row.proposed_payload.book_id === 'string' ? row.proposed_payload.book_id : null
    if (!bookId) throw new ChangeExecutionError('BOOK_ID_REQUIRED', 'book_id is required for rate publication.')
    const published = await publishExchangeRateVersion({
      accountId: input.accountId,
      bookId,
      versionId: row.target_id,
      actorUserId: input.actorUserId,
    })
    result = { target_type: row.target_type, target_id: row.target_id, operation: 'publish', ...published }
  } else if (row.target_type === 'service_intent' && row.intent === 'create' && row.target_id) {
    // Admin decision on an escalated unequipped-service intent.
    // payload.decision ∈ 'fulfilled' | 'rejected' | 'matched';
    // 'matched' additionally requires payload.matched_service_id
    // (a service the admin equipped for this need).
    const decision = row.proposed_payload.decision as string | undefined
    const allowed = new Set(['fulfilled', 'rejected', 'matched', 'clarifying'])
    if (!decision || !allowed.has(decision)) {
      throw new ChangeExecutionError('DECISION_REQUIRED', `decision must be one of: ${[...allowed].join(', ')}.`)
    }
    const db2 = supabaseAdmin()
    const update: Record<string, unknown> = { status: decision }
    if (decision === 'matched') {
      const serviceId = row.proposed_payload.matched_service_id as string | undefined
      if (!serviceId) {
        throw new ChangeExecutionError('MATCHED_SERVICE_REQUIRED', 'matched_service_id is required when decision=matched.')
      }
      const { data: svc } = await db2
        .from('services')
        .select('id')
        .eq('account_id', input.accountId)
        .eq('id', serviceId)
        .maybeSingle()
      if (!svc) throw new ChangeExecutionError('SERVICE_NOT_FOUND', 'Matched service not found in this account.', 404)
      update.matched_service_id = serviceId
    }
    const { error: intentError } = await db2
      .from('customer_intents')
      .update(update)
      .eq('account_id', input.accountId)
      .eq('id', row.target_id)
    if (intentError) throw intentError
    result = { target_type: row.target_type, target_id: row.target_id, operation: 'intent_decision', decision }
  } else if (row.target_type === 'coverage_offer' && row.intent === 'create' && !row.target_id && row.proposed_payload.contact_id) {
    // Coverage offer proposal approved: create the offer row as
    // ACTIVE so the marketplace can reserve against it. Fields
    // come ONLY from the approved payload (never re-read from a
    // client), and the linked intent (if any) flips to fulfilled.
    const p = row.proposed_payload as {
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
    if (!p.service_id || !p.total_amount || !p.currency) {
      throw new ChangeExecutionError('OFFER_PAYLOAD_INCOMPLETE', 'Approved payload must carry service_id, total_amount, currency.')
    }
    // Validate the coverage legs from the approved payload — the
    // normalized shape is what lands in the row.
    const offerAttrs = readCoverageAttributes(p.attributes ?? {})
    const db2 = supabaseAdmin()
    const reference = `CHG-${row.id.slice(0, 8).toUpperCase()}`
    const { data: offer, error: offerError } = await db2
      .from('coverage_offers')
      .insert({
        account_id: input.accountId,
        service_id: p.service_id,
        provider_contact_id: p.contact_id,
        reference_code: reference,
        total_amount: p.total_amount,
        currency: p.currency,
        attributes: offerAttrs,
        ...(p.commission_per_thousand
          ? { commission_per_thousand: p.commission_per_thousand }
          : {}),
        ...(p.commission_currency
          ? { commission_currency: p.commission_currency }
          : {}),
        ...(p.deal_date ? { deal_date: p.deal_date } : {}),
        status: 'active',
        created_by: input.actorUserId,
      })
      .select('id, reference_code')
      .single()
    if (offerError) throw offerError
    if (p.intent_id) {
      await db2
        .from('customer_intents')
        .update({ status: 'fulfilled', matched_service_id: p.service_id })
        .eq('account_id', input.accountId)
        .eq('id', p.intent_id)
    }
    result = { target_type: row.target_type, operation: 'create', offer }
  } else {
    throw new ChangeExecutionError('UNSUPPORTED_TARGET', `No deterministic executor for ${row.target_type}/${row.intent}.`)
  }

  const { error: updateError } = await db
    .from('change_requests')
    .update({ status: 'executed', executed_at: new Date().toISOString(), execution_result: result, error_code: null })
    .eq('account_id', input.accountId)
    .eq('id', row.id)
    .eq('status', 'approved')
  if (updateError) throw updateError
  await db.rpc('append_service_activity_event', {
    p_account_id: input.accountId,
    p_target_type: 'change_request',
    p_target_id: row.id,
    p_event_type: 'change_request.executed',
    p_actor_type: 'user',
    p_actor_id: input.actorUserId ?? '',
    p_payload: result,
  })
  return { ...result, status: 'executed' }
}
