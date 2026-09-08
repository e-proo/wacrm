import { supabaseAdmin } from '@/lib/ai/admin-client'
import { publishExchangeRateVersion } from '@/lib/services/domain-services'
import { publishPricingRuleRaw } from '@/lib/services/pricing/rules-crud'

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
