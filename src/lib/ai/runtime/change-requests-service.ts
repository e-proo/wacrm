import { supabaseAdmin } from '@/lib/ai/admin-client'
import { notifyTrustedAdminsOfChangeRequest } from './business-notifications'

export interface ChangeRequestRow {
  id: string
  account_id: string
  code: number
  target_type: string
  target_id: string | null
  intent: string
  proposed_payload: Record<string, unknown>
  expected_version: number | null
  idempotency_key: string
  status: string
  content_digest: string | null
  summary: string | null
  expires_at: string
  created_by: string | null
  created_at: string
  approved_by: string | null
  approved_at: string | null
  approved_identity_id: string | null
  approved_message_id: string | null
  approved_run_id: string | null
  rejected_by: string | null
  rejected_at: string | null
  executed_at: string | null
  execution_result: Record<string, unknown> | null
  error_code: string | null
}

export interface CreateChangeRequestInput {
  accountId: string
  targetType: string
  targetId: string | null
  intent: 'create' | 'create_and_attach' | 'update' | 'publish' | 'cancel' | 'archive'
  proposedPayload: Record<string, unknown>
  expectedVersion?: number | null
  idempotencyKey: string
  summary?: string | null
  actorUserId: string | null
}

export interface CreateChangeRequestResult {
  id: string
  code: number
  /** One-time PIN. Null for an idempotent replay of an existing request. */
  confirmationCode: string | null
  status: string
  contentDigest: string
}

export async function createChangeRequest(
  input: CreateChangeRequestInput,
): Promise<CreateChangeRequestResult> {
  const { data, error } = await supabaseAdmin().rpc('create_change_request_v2', {
    p_account_id: input.accountId,
    p_target_type: input.targetType,
    p_target_id: input.targetId,
    p_intent: input.intent,
    p_proposed_payload: input.proposedPayload,
    p_expected_version: input.expectedVersion ?? null,
    p_idempotency_key: input.idempotencyKey,
    p_summary: input.summary ?? null,
    p_actor_user_id: input.actorUserId,
  })
  if (error) {
    const code = (error as { code?: string }).code
    const msg = (error as { message?: string }).message ?? 'Create failed'
    throw new ChangeRequestError(
      code === 'P0001' ? 'CHANGE_REQUEST_INVALID_INPUT' : 'CHANGE_REQUEST_CREATE_FAILED',
      msg,
      code === 'P0001' ? 400 : 500,
    )
  }
  const row = (data as Array<{
    id: string
    code: number
    confirmation_code: string | null
    status: string
    content_digest: string
  }>)[0]
  if (!row) throw new ChangeRequestError('CHANGE_REQUEST_CREATE_FAILED', 'No row returned.', 500)

  try {
    const notification = await notifyTrustedAdminsOfChangeRequest({
      accountId: input.accountId,
      changeRequestId: row.id,
      requestCode: row.code,
      confirmationCode: row.confirmation_code,
      summary: input.summary ?? null,
      targetType: input.targetType,
      proposedPayload: input.proposedPayload,
    })
    console.info(
      `[change request] CHG-${row.code} admin notification eligible=${notification.eligible} whatsapp=${notification.whatsappSent} in_app=${notification.inAppCreated}`,
    )
  } catch (notifyError) {
    // The change request is the durable authority. A secondary notification
    // failure must never roll back or duplicate the proposal itself.
    console.error(`[change request] CHG-${row.code} admin notification failed:`, notifyError)
  }

  return {
    id: row.id,
    code: row.code,
    confirmationCode: row.confirmation_code,
    status: row.status,
    contentDigest: row.content_digest,
  }
}

/** Dashboard approval: authenticated admin + one-time PIN + digest check. */
export async function approveChangeRequest(input: {
  accountId: string
  changeRequestId: string
  confirmationCode: string
  actorUserId: string | null
}): Promise<{ status: string }> {
  if (!input.actorUserId) {
    throw new ChangeRequestError('CHANGE_REQUEST_APPROVER_REQUIRED', 'Authenticated approver is required.', 401)
  }
  const { data, error } = await supabaseAdmin().rpc('approve_change_request_dashboard_v2', {
    p_account_id: input.accountId,
    p_change_request_id: input.changeRequestId,
    p_confirmation_code: input.confirmationCode,
    p_actor_user_id: input.actorUserId,
  })
  if (error) {
    throw new ChangeRequestError(
      mapRpcError((error as { message?: string }).message ?? ''),
      (error as { message?: string }).message ?? 'Approval failed',
      409,
    )
  }
  return { status: data as string }
}

/** WhatsApp approval: verified identity capability + one-time PIN + message binding. */
export async function approveChangeRequestFromTrustedAdmin(input: {
  accountId: string
  requestCode: number
  confirmationCode: string
  identityId: string
  inboundMessageId: string | null
  runId?: string | null
}): Promise<{ id: string; status: string }> {
  const { data, error } = await supabaseAdmin().rpc('approve_change_request_by_code_v2', {
    p_account_id: input.accountId,
    p_request_code: input.requestCode,
    p_confirmation_code: input.confirmationCode,
    p_identity_id: input.identityId,
    p_message_id: input.inboundMessageId,
    p_run_id: input.runId ?? null,
  })
  if (error) {
    throw new ChangeRequestError(
      mapRpcError((error as { message?: string }).message ?? ''),
      (error as { message?: string }).message ?? 'Approval failed',
      409,
    )
  }
  const row = (data as Array<{ id: string; status: string }>)[0]
  if (!row) throw new ChangeRequestError('CHANGE_REQUEST_FAILED', 'Approval returned no request.', 500)
  return row
}

export async function rejectChangeRequest(input: {
  accountId: string
  changeRequestId: string
  actorUserId: string | null
  reason?: string | null
}): Promise<{ status: string }> {
  const { data, error } = await supabaseAdmin().rpc('reject_change_request', {
    p_account_id: input.accountId,
    p_change_request_id: input.changeRequestId,
    p_actor_user_id: input.actorUserId,
    p_reason: input.reason ?? null,
  })
  if (error) {
    throw new ChangeRequestError(mapRpcError(error.message ?? ''), error.message ?? 'Reject failed', 409)
  }
  try {
    await enqueueCustomerIntentRejection(input.accountId, input.changeRequestId)
  } catch (notifyErr) {
    // Rejection itself is authoritative; notification is a durable follow-up
    // and must not roll the human decision back.
    console.error('[change request] could not enqueue rejection notification:', notifyErr)
  }
  return { status: data as string }
}

async function enqueueCustomerIntentRejection(
  accountId: string,
  changeRequestId: string,
): Promise<void> {
  const db = supabaseAdmin()
  const { data: intent, error } = await db
    .from('customer_intents')
    .select('id, contact_id, conversation_id')
    .eq('account_id', accountId)
    .eq('change_request_id', changeRequestId)
    .maybeSingle()
  if (error) throw error
  if (!intent) return

  const { error: intentUpdateError } = await db
    .from('customer_intents')
    .update({ status: 'rejected', updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('id', intent.id)
  if (intentUpdateError) throw intentUpdateError

  if (!intent.conversation_id || !intent.contact_id) return
  const { error: insertError } = await db
    .from('customer_intent_notifications')
    .upsert(
      {
        account_id: accountId,
        intent_id: intent.id,
        change_request_id: changeRequestId,
        contact_id: intent.contact_id,
        conversation_id: intent.conversation_id,
        event_type: 'rejected',
        message_text: 'تمت مراجعة طلبك من الإدارة ولم يتم اعتماده.',
        status: 'pending',
      },
      {
        onConflict: 'account_id,intent_id,change_request_id,event_type',
        ignoreDuplicates: true,
      },
    )
  if (insertError) throw insertError
}

export async function cancelChangeRequest(input: {
  accountId: string
  changeRequestId: string
  actorUserId: string | null
}): Promise<{ status: string }> {
  const { data, error } = await supabaseAdmin().rpc('cancel_change_request', {
    p_account_id: input.accountId,
    p_change_request_id: input.changeRequestId,
    p_actor_user_id: input.actorUserId,
  })
  if (error) {
    throw new ChangeRequestError(mapRpcError(error.message ?? ''), error.message ?? 'Cancel failed', 409)
  }
  return { status: data as string }
}

export async function findChangeRequestByIdempotencyKey(
  accountId: string,
  idempotencyKey: string,
): Promise<Pick<ChangeRequestRow, 'id' | 'code' | 'status' | 'target_type' | 'target_id' | 'idempotency_key'> | null> {
  const { data, error } = await supabaseAdmin()
    .from('change_requests')
    .select('id, code, status, target_type, target_id, idempotency_key')
    .eq('account_id', accountId)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle()
  if (error) throw error
  return (data as Pick<
    ChangeRequestRow,
    'id' | 'code' | 'status' | 'target_type' | 'target_id' | 'idempotency_key'
  > | null) ?? null
}

export async function listChangeRequests(
  accountId: string,
  opts: { status?: string; limit?: number } = {},
): Promise<ChangeRequestRow[]> {
  const limit = Math.min(opts.limit ?? 100, 500)
  let q = supabaseAdmin()
    .from('change_requests')
    // Never select confirmation_code or confirmation_code_hash.
    .select(
      'id, account_id, code, target_type, target_id, intent, proposed_payload, expected_version, idempotency_key, status, content_digest, summary, expires_at, created_by, created_at, approved_by, approved_at, approved_identity_id, approved_message_id, approved_run_id, rejected_by, rejected_at, executed_at, execution_result, error_code',
    )
    .eq('account_id', accountId)
    .order('code', { ascending: false })
    .limit(limit)
  if (opts.status) q = q.eq('status', opts.status)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as unknown as ChangeRequestRow[]
}

export class ChangeRequestError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'ChangeRequestError'
    this.code = code
    this.status = status
  }
}

function mapRpcError(msg: string): string {
  const known = [
    'CHANGE_REQUEST_NOT_FOUND',
    'CHANGE_REQUEST_EXPIRED',
    'CHANGE_REQUEST_BAD_CODE',
    'CHANGE_REQUEST_NOT_PENDING',
    'CHANGE_REQUEST_TOO_MANY_ATTEMPTS',
    'CHANGE_REQUEST_CONTENT_CHANGED',
    'CHANGE_REQUEST_APPROVER_FORBIDDEN',
    'TRUSTED_ADMIN_REQUIRED',
    'APPROVER_CAPABILITY_REQUIRED',
  ]
  return known.find((code) => msg.includes(code)) ?? 'CHANGE_REQUEST_FAILED'
}
