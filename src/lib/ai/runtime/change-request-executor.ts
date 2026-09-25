import { supabaseAdmin } from '@/lib/ai/admin-client'
import { tryExecuteCurrentChangeAction } from '@/lib/services/platform/composition'
import { DomainChangeExecutionError } from '@/lib/services/platform/change-executor-registry'

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

interface ClaimedChange {
  id: string
  action_key: string | null
  action_version: number | null
  target_type: string
  target_id: string | null
  intent: string
  proposed_payload: Record<string, unknown>
  expected_version: number | null
  content_digest: string
  claim_token: string
}

interface CustomerNotificationDescriptor {
  intent_id?: string
  event_type?: string
  message_text?: string
  render_from_business_event?: boolean
}

const BUSINESS_EVENT_RENDER_AT_DELIVERY_MARKER =
  '__BUSINESS_EVENT_RENDER_AT_DELIVERY__'

export async function executeApprovedChangeRequest(input: {
  accountId: string
  changeRequestId: string
  actorUserId: string | null
}): Promise<Record<string, unknown>> {
  const db = supabaseAdmin()
  const { data: claimedRows, error: claimError } = await db.rpc(
    'claim_change_request_execution_v2',
    {
      p_account_id: input.accountId,
      p_change_request_id: input.changeRequestId,
    },
  )
  if (claimError) {
    throw new ChangeExecutionError(
      mapClaimError(claimError.message ?? ''),
      claimError.message ?? 'Could not claim change request.',
    )
  }
  const row = (claimedRows as ClaimedChange[] | null)?.[0]
  if (!row) {
    const { data: current, error } = await db
      .from('change_requests')
      .select('status, execution_result')
      .eq('account_id', input.accountId)
      .eq('id', input.changeRequestId)
      .maybeSingle()
    if (error) throw error
    if (current?.status === 'executed') {
      return {
        status: 'executed',
        id: input.changeRequestId,
        idempotent: true,
        ...((current.execution_result as Record<string, unknown> | null) ?? {}),
      }
    }
    throw new ChangeExecutionError('EXECUTION_CLAIM_LOST', 'Change request could not be claimed.')
  }

  try {
    await assertExpectedVersion(db, input.accountId, row)
    const result = await executeClaimedTarget(input, row)
    const { data: completed, error: completeError } = await db.rpc(
      'complete_change_request_execution',
      {
        p_account_id: input.accountId,
        p_change_request_id: row.id,
        p_claim_token: row.claim_token,
        p_result: result,
      },
    )
    if (completeError) throw completeError
    if (completed !== true) {
      throw new ChangeExecutionError(
        'EXECUTION_COMPLETION_CONFLICT',
        'The change was applied but completion ownership was lost; reconcile before retrying.',
        500,
      )
    }

    await db.rpc('append_service_activity_event', {
      p_account_id: input.accountId,
      p_target_type: 'change_request',
      p_target_id: row.id,
      p_event_type: 'change_request.executed',
      p_actor_type: 'user',
      p_actor_id: input.actorUserId ?? '',
      p_payload: result,
    })
    try {
      await enqueueCustomerNotification(db, input.accountId, row.id, result)
    } catch (notifyErr) {
      console.error('[change request] could not enqueue customer notification:', notifyErr)
    }
    return { ...result, status: 'executed' }
  } catch (err) {
    const code = err instanceof ChangeExecutionError ? err.code : 'EXECUTION_FAILED'
    const { error: failError } = await db.rpc('fail_change_request_execution', {
      p_account_id: input.accountId,
      p_change_request_id: row.id,
      p_claim_token: row.claim_token,
      p_error_code: code,
    })
    if (failError) console.error('[change request] failed to persist execution failure:', failError)
    throw err
  }
}

async function executeClaimedTarget(
  input: { accountId: string; changeRequestId: string; actorUserId: string | null },
  row: ClaimedChange,
): Promise<Record<string, unknown>> {
  try {
    const platformAttempt = await tryExecuteCurrentChangeAction(
      {
        accountId: input.accountId,
        changeRequestId: row.id,
        actorUserId: input.actorUserId,
      },
      {
        id: row.id,
        actionKey: row.action_key,
        actionVersion: row.action_version,
        targetType: row.target_type,
        targetId: row.target_id,
        intent: row.intent,
        proposedPayload: row.proposed_payload,
        expectedVersion: row.expected_version,
        contentDigest: row.content_digest,
        claimToken: row.claim_token,
      },
    )
    if (platformAttempt.matched) return platformAttempt.result
  } catch (error) {
    if (error instanceof DomainChangeExecutionError) {
      throw new ChangeExecutionError(error.code, error.message, error.status)
    }
    throw error
  }

  throw new ChangeExecutionError(
    'UNSUPPORTED_TARGET',
    `No deterministic executor for ${row.target_type}/${row.intent}.`,
  )
}

async function enqueueCustomerNotification(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  changeRequestId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const notification = result.customer_notification as CustomerNotificationDescriptor | undefined
  if (!notification?.intent_id || !notification.event_type) return

  const { data: intent, error: intentError } = await db
    .from('customer_intents')
    .select('id, contact_id, conversation_id')
    .eq('account_id', accountId)
    .eq('id', notification.intent_id)
    .maybeSingle()
  if (intentError) throw intentError
  if (!intent?.conversation_id || !intent.contact_id) return

  const explicitMessageText = notification.message_text?.trim() || null
  const messageText =
    explicitMessageText ??
    (notification.render_from_business_event
      ? BUSINESS_EVENT_RENDER_AT_DELIVERY_MARKER
      : null)
  if (!messageText) return

  const { error } = await db
    .from('customer_intent_notifications')
    .upsert(
      {
        account_id: accountId,
        intent_id: notification.intent_id,
        change_request_id: changeRequestId,
        contact_id: intent.contact_id,
        conversation_id: intent.conversation_id,
        event_type: notification.event_type,
        message_text: messageText,
        status: 'pending',
      },
      {
        onConflict: 'account_id,intent_id,change_request_id,event_type',
        ignoreDuplicates: true,
      },
    )
  if (error) throw error
}

async function assertExpectedVersion(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  row: ClaimedChange,
): Promise<void> {
  if (row.expected_version == null) return
  if (!row.target_id) {
    throw new ChangeExecutionError(
      'EXPECTED_VERSION_WITHOUT_TARGET',
      'expected_version cannot be used without a target row.',
    )
  }

  const versionedTables: Record<string, string> = {
    service: 'services',
    ai_agent: 'ai_agents',
  }
  const table = versionedTables[row.target_type]
  if (!table) {
    throw new ChangeExecutionError(
      'EXPECTED_VERSION_UNSUPPORTED',
      `Target ${row.target_type} does not expose a runtime version check.`,
    )
  }
  const { data, error } = await db
    .from(table)
    .select('version')
    .eq('account_id', accountId)
    .eq('id', row.target_id)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new ChangeExecutionError('TARGET_NOT_FOUND', 'Change target not found.', 404)
  if (Number((data as { version: number }).version) !== Number(row.expected_version)) {
    throw new ChangeExecutionError('EXPECTED_VERSION_CONFLICT', 'Target changed after this proposal was created.')
  }
}

function mapClaimError(message: string): string {
  const known = [
    'CHANGE_REQUEST_NOT_FOUND',
    'CHANGE_REQUEST_NOT_APPROVED',
    'CHANGE_REQUEST_EXPIRED',
    'CHANGE_REQUEST_CONTENT_CHANGED',
    'CHANGE_REQUEST_EXECUTION_RACE',
  ]
  return known.find((code) => message.includes(code)) ?? 'EXECUTION_CLAIM_FAILED'
}
