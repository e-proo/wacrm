// Server-only by convention.
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { createChangeRequest } from '@/lib/ai/runtime/change-requests-service'
import { DomainError } from '@/lib/services/platform/domain-error'

// ============================================================
// Customer intents — the agent's GENERAL memory of unequipped
// service needs/offers, plus admin escalation.
//
// Recording happens through a service-role SQL RPC so the agent
// (which runs under the service role in the dispatch path) can
// write its own observations without bypassing scoping: the
// account_id is ALWAYS derived server-side, never from args.
// Admin updates (status, matched service) go through RLS.
// ============================================================

export interface CustomerIntentRow {
  id: string
  account_id: string
  contact_id: string
  conversation_id: string | null
  direction: 'offer' | 'request'
  service_hint: string
  summary: string | null
  status: 'new' | 'clarifying' | 'forwarded_to_admin' | 'fulfilled' | 'rejected' | 'matched'
  attributes: Record<string, unknown>
  matched_service_id: string | null
  change_request_id: string | null
  created_at: string
  updated_at: string
}

export class IntentError extends DomainError {
  constructor(code: string, message: string, status = 400) {
    super(code, message, status)
    this.name = 'IntentError'
  }
}

export interface RecordIntentInput {
  accountId: string
  contactId: string
  conversationId: string | null
  direction: 'offer' | 'request'
  serviceHint: string
  summary?: string | null
  attributes?: Record<string, unknown>
  /** When true, also create an escalation change request for the
   *  admin plane and flip the intent to forwarded_to_admin. */
  escalateToAdmin?: boolean
  actorUserId: string | null
}

export interface RecordedIntent {
  intentId: string
  status: CustomerIntentRow['status']
  changeRequest: { id: string; code: number; confirmationCode: string | null } | null
}

export async function recordIntent(
  input: RecordIntentInput,
): Promise<RecordedIntent> {
  if (!input.contactId) {
    throw new IntentError('CONTACT_REQUIRED', 'contactId is required.')
  }
  if (!input.serviceHint?.trim()) {
    throw new IntentError('SERVICE_HINT_REQUIRED', 'serviceHint is required.')
  }
  if (input.direction !== 'offer' && input.direction !== 'request') {
    throw new IntentError('DIRECTION_INVALID', 'direction must be offer or request.')
  }

  const idempotencyKey = `intent:${input.contactId}:${input.direction}:${input.serviceHint.trim().toLowerCase().slice(0, 80)}`

  const { data, error } = await supabaseAdmin().rpc('create_customer_intent', {
    p_account_id: input.accountId,
    p_contact_id: input.contactId,
    p_conversation_id: input.conversationId,
    p_direction: input.direction,
    p_service_hint: input.serviceHint.trim().slice(0, 300),
    p_summary: input.summary?.slice(0, 2000) ?? null,
    p_attributes: input.attributes ?? {},
    p_idempotency_key: idempotencyKey,
    p_actor_user_id: input.actorUserId,
  })
  if (error) {
    const msg = (error as { message?: string }).message ?? 'Intent creation failed'
    throw new IntentError(
      msg.includes('INTENT_INVALID_DIRECTION') ? 'DIRECTION_INVALID'
        : msg.includes('INTENT_INVALID_IDEMPOTENCY_KEY') ? 'IDEMPOTENCY_KEY_INVALID'
        : 'INTENT_CREATE_FAILED',
      msg,
      400,
    )
  }
  const intentId = data as string

  if (!input.escalateToAdmin) {
    return { intentId, status: 'new', changeRequest: null }
  }

  // Escalation through the SAME approval engine every other admin
  // change uses — same confirmation codes, expiry, audit.
  const escalation = await createChangeRequest({
    accountId: input.accountId,
    targetType: 'service_intent',
    targetId: intentId,
    intent: 'create',
    proposedPayload: {
      intent_id: intentId,
      direction: input.direction,
      service_hint: input.serviceHint,
      summary: input.summary ?? null,
      attributes: input.attributes ?? {},
    },
    idempotencyKey: `intent-escalate:${intentId}`,
    summary:
      `Customer ${input.direction}: ${input.serviceHint}` +
      (input.summary ? ` — ${input.summary}` : ''),
    actorUserId: input.actorUserId,
  })

  const db = supabaseAdmin()
  const { error: linkError } = await db
    .from('customer_intents')
    .update({ status: 'forwarded_to_admin', change_request_id: escalation.id })
    .eq('account_id', input.accountId)
    .eq('id', intentId)
    .eq('status', 'new')
  if (linkError) throw linkError

  return {
    intentId,
    status: 'forwarded_to_admin',
    changeRequest: {
      id: escalation.id,
      code: escalation.code,
      confirmationCode: escalation.confirmationCode,
    },
  }
}

export async function listIntents(
  accountId: string,
  opts: { status?: string; contactId?: string; q?: string; limit?: number } = {},
): Promise<CustomerIntentRow[]> {
  const limit = Math.min(opts.limit ?? 100, 500)
  let q = supabaseAdmin()
    .from('customer_intents')
    .select(
      'id, account_id, contact_id, conversation_id, direction, service_hint, summary, status, attributes, matched_service_id, change_request_id, created_at, updated_at',
    )
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (opts.status) q = q.eq('status', opts.status)
  if (opts.contactId) q = q.eq('contact_id', opts.contactId)
  if (opts.q?.trim()) {
    const term = `%${opts.q.trim()}%`
    q = q.or(`service_hint.ilike.${term},summary.ilike.${term}`)
  }
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as unknown as CustomerIntentRow[]
}

const VALID_STATUSES = new Set([
  'new',
  'clarifying',
  'forwarded_to_admin',
  'fulfilled',
  'rejected',
  'matched',
])

export async function updateIntent(
  accountId: string,
  intentId: string,
  patch: { status?: CustomerIntentRow['status']; matchedServiceId?: string | null; summary?: string | null },
  actorUserId: string | null,
): Promise<CustomerIntentRow> {
  const update: Record<string, unknown> = {}
  if (patch.status !== undefined) {
    if (!VALID_STATUSES.has(patch.status)) {
      throw new IntentError('STATUS_INVALID', `Unknown status ${patch.status}.`)
    }
    update.status = patch.status
  }
  if (patch.matchedServiceId !== undefined) {
    update.matched_service_id = patch.matchedServiceId
    if (patch.matchedServiceId && !patch.status) update.status = 'matched'
  }
  if (patch.summary !== undefined) update.summary = patch.summary
  if (Object.keys(update).length === 0) {
    throw new IntentError('NOTHING_TO_UPDATE', 'Provide a field to update.')
  }
  const { data, error } = await supabaseAdmin()
    .from('customer_intents')
    .update(update)
    .eq('account_id', accountId)
    .eq('id', intentId)
    .select(
      'id, account_id, contact_id, conversation_id, direction, service_hint, summary, status, attributes, matched_service_id, change_request_id, created_at, updated_at',
    )
    .maybeSingle()
  if (error) throw error
  if (!data) throw new IntentError('NOT_FOUND', 'Intent not found.', 404)
  const row = data as unknown as CustomerIntentRow
  await supabaseAdmin().rpc('append_service_activity_event', {
    p_account_id: accountId,
    p_target_type: 'customer_intent',
    p_target_id: intentId,
    p_event_type: 'customer_intent.updated',
    p_actor_type: 'user',
    p_actor_id: actorUserId ?? '',
    p_payload: update,
  })
  return row
}

export async function getIntent(
  accountId: string,
  intentId: string,
): Promise<CustomerIntentRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('customer_intents')
    .select(
      'id, account_id, contact_id, conversation_id, direction, service_hint, summary, status, attributes, matched_service_id, change_request_id, created_at, updated_at',
    )
    .eq('account_id', accountId)
    .eq('id', intentId)
    .maybeSingle()
  if (error) throw error
  return (data as unknown as CustomerIntentRow | null) ?? null
}
