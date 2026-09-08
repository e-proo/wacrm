// Server-only by convention.
import { supabaseAdmin } from '@/lib/ai/admin-client'

// ============================================================
// Change-request service (Phase 3).
//
// Thin glue around the SQL RPCs in migration 054. The agent
// uses these to:
//   • draft a new change request (createChangeRequest),
//   • confirm an admin's approval (approveChangeRequest),
//   • cancel a pending one (cancelChangeRequest),
//   • reject one (rejectChangeRequest),
//   • list / read existing requests for UI surfacing.
//
// Execution of the change happens INSIDE the SQL RPCs as the
// engine grows (Phase 3 ships the approval primitive; Phase 4
// wires the dispatch into an `execute_change_request` RPC per
// target_type). For now `status='approved'` is the final state —
// the UI lets a human drive the actual apply from a button.
//
// All IDs/keys returned by this service are SAFE to surface
// back to admins (no secrets). The confirmation code is short
// enough to type back over WhatsApp.
// ============================================================

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
  confirmation_code: string
  summary: string | null
  expires_at: string
  created_by: string | null
  created_at: string
  approved_by: string | null
  approved_at: string | null
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
  intent: 'create' | 'update' | 'publish' | 'cancel' | 'archive'
  proposedPayload: Record<string, unknown>
  expectedVersion?: number | null
  idempotencyKey: string
  summary?: string | null
  actorUserId: string | null
}

export interface CreateChangeRequestResult {
  id: string
  code: number
  confirmationCode: string
  status: string
}

export async function createChangeRequest(
  input: CreateChangeRequestInput,
): Promise<CreateChangeRequestResult> {
  const { data, error } = await supabaseAdmin().rpc('create_change_request', {
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
    confirmation_code: string
    status: string
  }>)[0]
  if (!row) {
    throw new ChangeRequestError('CHANGE_REQUEST_CREATE_FAILED', 'No row returned.', 500)
  }
  return {
    id: row.id,
    code: row.code,
    confirmationCode: row.confirmation_code,
    status: row.status,
  }
}

export async function approveChangeRequest(input: {
  accountId: string
  changeRequestId: string
  confirmationCode: string
  actorUserId: string | null
}): Promise<{ status: string }> {
  const { data, error } = await supabaseAdmin().rpc('approve_change_request', {
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
    throw new ChangeRequestError(
      mapRpcError((error as { message?: string }).message ?? ''),
      (error as { message?: string }).message ?? 'Reject failed',
      409,
    )
  }
  return { status: data as string }
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
    throw new ChangeRequestError(
      mapRpcError((error as { message?: string }).message ?? ''),
      (error as { message?: string }).message ?? 'Cancel failed',
      409,
    )
  }
  return { status: data as string }
}

export async function listChangeRequests(
  accountId: string,
  opts: { status?: string; limit?: number } = {},
): Promise<ChangeRequestRow[]> {
  const limit = Math.min(opts.limit ?? 100, 500)
  let q = supabaseAdmin()
    .from('change_requests')
    .select(
      'id, account_id, code, target_type, target_id, intent, proposed_payload, expected_version, idempotency_key, status, confirmation_code, summary, expires_at, created_by, created_at, approved_by, approved_at, rejected_by, rejected_at, executed_at, execution_result, error_code',
    )
    .eq('account_id', accountId)
    .order('code', { ascending: false })
    .limit(limit)
  if (opts.status) q = q.eq('status', opts.status)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as unknown as ChangeRequestRow[]
}

export async function getChangeRequest(
  accountId: string,
  id: string,
): Promise<ChangeRequestRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('change_requests')
    .select(
      'id, account_id, code, target_type, target_id, intent, proposed_payload, expected_version, idempotency_key, status, confirmation_code, summary, expires_at, created_by, created_at, approved_by, approved_at, rejected_by, rejected_at, executed_at, execution_result, error_code',
    )
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data as unknown as ChangeRequestRow | null
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
  if (msg.includes('CHANGE_REQUEST_NOT_FOUND')) return 'CHANGE_REQUEST_NOT_FOUND'
  if (msg.includes('CHANGE_REQUEST_EXPIRED')) return 'CHANGE_REQUEST_EXPIRED'
  if (msg.includes('CHANGE_REQUEST_BAD_CODE')) return 'CHANGE_REQUEST_BAD_CODE'
  if (msg.includes('CHANGE_REQUEST_NOT_PENDING'))
    return 'CHANGE_REQUEST_NOT_PENDING'
  return 'CHANGE_REQUEST_FAILED'
}
