import { supabaseAdmin } from '../admin-client'
import { loadAccountRuntimePolicy } from './runtime-policy'
import { sweepAgentRuns } from './recovery'
import { resumeQueuedAgentRun } from './dispatch'
import { executeApprovedChangeRequest } from './change-request-executor'
import { deliverCustomerOutcomeNotifications } from './customer-notification-delivery'

export interface AgentWorkerResult {
  swept: { scanned: number; reaped: number }
  scannedQueued: number
  attempted: number
  completed: number
  skippedByPolicy: number
  failed: number
  notifications: NotificationWorkerResult
  changeRequests: ChangeRequestWorkerResult
}


export interface ChangeRequestWorkerResult {
  scanned: number
  attempted: number
  executed: number
  failed: number
  skippedByPolicy: number
}

/**
 * Closes the approval -> execution gap. We only recover requests that are
 * still `approved`, i.e. execution never successfully claimed them. Requests
 * already marked failed/executing are deliberately not blind-retried here.
 */
export async function processApprovedChangeRequests(input: {
  limit?: number
}): Promise<ChangeRequestWorkerResult> {
  const db = supabaseAdmin()
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100))
  const { data: candidates, error } = await db
    .from('change_requests')
    .select('id, account_id, approved_by, approved_at')
    .eq('status', 'approved')
    .order('approved_at', { ascending: true })
    .limit(limit)
  if (error) throw error

  let attempted = 0
  let executed = 0
  let failed = 0
  let skippedByPolicy = 0
  for (const raw of candidates ?? []) {
    const row = raw as {
      id: string
      account_id: string
      approved_by: string | null
      approved_at: string | null
    }
    const policy = await loadAccountRuntimePolicy(db, row.account_id)
    if (!policy.recoveryWorkerEnabled) {
      skippedByPolicy += 1
      continue
    }
    attempted += 1
    try {
      await executeApprovedChangeRequest({
        accountId: row.account_id,
        changeRequestId: row.id,
        actorUserId: row.approved_by,
      })
      executed += 1
    } catch (err) {
      failed += 1
      console.error('[change request worker] execution failed:', row.id, err)
    }
  }

  return {
    scanned: (candidates ?? []).length,
    attempted,
    executed,
    failed,
    skippedByPolicy,
  }
}

export interface NotificationWorkerResult {
  scanned: number
  attempted: number
  sent: number
  requiresReconciliation: number
  failed: number
  skippedByPolicy: number
}

interface NotificationAccountCandidate {
  account_id: string
}

/**
 * One bounded worker tick for durable customer business events.
 *
 * Candidate discovery may see both the legacy table and active general outbox,
 * but claiming/sending is delegated to deliverCustomerOutcomeNotifications().
 * That function is the single route-aware delivery boundary: active general
 * events are claimed first, then any remaining budget is offered to the legacy
 * RPC, whose FX claim is disabled while the FX route is active.
 */
export async function processCustomerIntentNotifications(input: {
  limit?: number
}): Promise<NotificationWorkerResult> {
  const db = supabaseAdmin()
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100))
  const now = new Date().toISOString()

  const [
    { data: legacyCandidates, error: legacyError },
    { data: activeCandidates, error: activeError },
  ] = await Promise.all([
    db
      .from('customer_intent_notifications')
      .select('account_id')
      .eq('status', 'pending')
      .lte('available_at', now)
      .order('created_at', { ascending: true })
      .limit(limit),
    db
      .from('business_event_outbox')
      .select('account_id')
      .eq('delivery_mode', 'active')
      .eq('status', 'pending')
      .eq('audience', 'customer')
      .eq('channel', 'whatsapp')
      .lte('available_at', now)
      .order('created_at', { ascending: true })
      .limit(limit),
  ])
  if (legacyError) throw legacyError
  if (activeError) throw activeError

  const candidateRows = [
    ...((activeCandidates ?? []) as NotificationAccountCandidate[]),
    ...((legacyCandidates ?? []) as NotificationAccountCandidate[]),
  ]
  const accountIds = [...new Set(candidateRows.map((row) => row.account_id))]

  let attempted = 0
  let sent = 0
  let requiresReconciliation = 0
  let failed = 0
  let skippedByPolicy = 0

  for (const accountId of accountIds) {
    if (attempted >= limit) break

    const policy = await loadAccountRuntimePolicy(db, accountId)
    if (!policy.recoveryWorkerEnabled) {
      skippedByPolicy += 1
      continue
    }

    try {
      const delivery = await deliverCustomerOutcomeNotifications({
        accountId,
        limit: limit - attempted,
      })
      attempted += delivery.claimed
      sent += delivery.sent
      requiresReconciliation += delivery.reconciliation
      failed += delivery.failed
    } catch (err) {
      failed += 1
      console.error('[customer business event worker] delivery failed:', accountId, err)
    }
  }

  return {
    scanned: candidateRows.length,
    attempted,
    sent,
    requiresReconciliation,
    failed,
    skippedByPolicy,
  }
}

export async function processAgentRunQueue(input: {
  workerId: string
  limit?: number
}): Promise<AgentWorkerResult> {
  const db = supabaseAdmin()
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100))
  const changeRequests = await processApprovedChangeRequests({ limit })
  const notifications = await processCustomerIntentNotifications({ limit })
  const swept = await sweepAgentRuns(db)
  const { data: candidates, error } = await db
    .from('ai_agent_runs')
    .select('id, account_id')
    .eq('status', 'queued')
    .lte('available_at', new Date().toISOString())
    .order('available_at', { ascending: true })
    .limit(limit)
  if (error) throw error

  let attempted = 0
  let completed = 0
  let skippedByPolicy = 0
  let failed = 0
  for (const candidate of candidates ?? []) {
    const row = candidate as { id: string; account_id: string }
    const policy = await loadAccountRuntimePolicy(db, row.account_id)
    if (!policy.recoveryWorkerEnabled || policy.killSwitch || !policy.multiAgentEnabled) {
      skippedByPolicy += 1
      continue
    }
    attempted += 1
    try {
      const outcome = await resumeQueuedAgentRun(row.id, input.workerId)
      if (outcome === 'succeeded' || outcome === 'handoff') completed += 1
      else if (outcome === 'failed') failed += 1
    } catch (err) {
      failed += 1
      console.error('[ai worker] run failed:', row.id, err)
    }
  }
  return {
    swept,
    scannedQueued: (candidates ?? []).length,
    attempted,
    completed,
    skippedByPolicy,
    failed,
    notifications,
    changeRequests,
  }
}
