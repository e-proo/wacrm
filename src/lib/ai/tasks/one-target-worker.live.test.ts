import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { supabaseAdmin } from '../admin-client'
import { inspectAgentTaskTestCutoverReadiness } from './cutover'
import { processAgentTaskQueue } from './orchestrator'
import { processAgentTaskOutboundRunQueue } from './outbound-worker'
import { evaluateCurrentTaskCompletion } from './current-platform'
import { assertScopedOpenWATestPilotMode, inspectOpenWAGuardrailReservationWindow } from './one-target-guardrail-preflight'

/**
 * SOF-63: manually tick only the Task Orchestrator and the outbound
 * Agent Task worker, NOT the generic /api/internal/ai-agent-worker handler.
 *
 * Stage prepare NEVER sends. Stage send requires a *second* explicit command.
 * The global queues must be exclusive to the designated TEST Task because
 * the existing claim_next_agent_task RPC is not account-scoped.
 * No background scheduling, no retries and no legacy change-request worker.
 */
const enabled = process.env.WACRM_AGENT_TASK_ONE_TARGET_LIVE === '1'
const stage = process.env.WACRM_AGENT_TASK_ONE_TARGET_STAGE
const TEST_PROJECT = 'pqirsnfupofhulmewakq'
const TEST_ACCOUNT = '8ed95309-96cd-4347-b725-bd8c5039ed4f'
// Explicit operator-supplied TEST-only request. Never accept arbitrary CRM services.
const TEST_REQUEST = process.env.WACRM_AGENT_TASK_ONE_TARGET_REQUEST_ID
const HISTORICAL_FAILED_REQUEST = '013d52e8-fe89-42a5-9656-01e02006dc21'
const TEST_SERVICE = '4648674f-8107-424c-aa63-b2e6c78f81df'
const TEST_CONTACT = '98461de0-d275-49cb-b7f5-b7fae06739bf'
const TEST_CONNECTION = '02527740-9806-45ae-b9b1-1354c25f1d3f'
const TEST_REQUEST_NOTE_PREFIX = '[SOF63 TEST ONLY]'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function must(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error('SOF63_ONE_TARGET_' + code)
}

function fields(row: unknown): Record<string, unknown> {
  must(row && typeof row === 'object' && !Array.isArray(row), 'INVALID_ROW')
  return row as Record<string, unknown>
}

function accountConfig() {
  const accountId = process.env.WACRM_AGENT_TASK_CUTOVER_ACCOUNT_ID
  const taskId = process.env.WACRM_AGENT_TASK_ONE_TARGET_TASK_ID
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  must(accountId === TEST_ACCOUNT, 'EXPECTED_TEST_ACCOUNT_REQUIRED')
  must(taskId && UUID_RE.test(taskId), 'TASK_ID_REQUIRED')
  must(url && new URL(url).hostname === TEST_PROJECT + '.supabase.co', 'TEST_PROJECT_REQUIRED')
  must(process.env.SUPABASE_SERVICE_ROLE_KEY, 'SERVICE_ROLE_REQUIRED')
  return { accountId, taskId }
}

async function loadExclusiveTask(stageName: 'prepare' | 'send') {
  const { accountId, taskId } = accountConfig()
  const db = supabaseAdmin()
  const now = new Date().toISOString()
  const { data: rawTask, error: taskError } = await db.from('ai_agent_tasks')
    .select('id,account_id,status,task_type,task_type_version,task_context,target_policy,agent_revision_id,max_targets,max_attempts_per_target,available_at')
    .eq('account_id', accountId).eq('id', taskId).maybeSingle()
  if (taskError) throw taskError
  const task = fields(rawTask)
  const policy = fields(task.target_policy)
  const context = fields(task.task_context)
  must(task.task_type === 'coverage.sourcing' && task.task_type_version === 2, 'NOT_COVERAGE_V2')
  must(typeof TEST_REQUEST === 'string' && UUID_RE.test(TEST_REQUEST),
    'EXPECTED_TEST_REQUEST_ID_REQUIRED')
  must(context.coverageRequestId === TEST_REQUEST, 'NOT_TEST_FIXTURE_REQUEST')
  const { data: fixture, error: fixtureError } = await db.from('coverage_requests')
    .select('id,service_id,status,notes,currency,requested_amount,requester_contact_id,created_at')
    .eq('account_id', accountId).eq('id', TEST_REQUEST).maybeSingle()
  if (fixtureError) throw fixtureError
  must(fixture?.id === TEST_REQUEST && fixture.service_id === TEST_SERVICE &&
    fixture.status === 'active' &&
    typeof fixture.notes === 'string' &&
    fixture.notes.startsWith(TEST_REQUEST_NOTE_PREFIX) &&
    // Exclude the original request that was created before first acceptance.
    Date.parse(fixture.created_at) > Date.parse('2026-11-14T14:33:15Z') &&
    fixture.currency === 'SAR' && Number(fixture.requested_amount) === 100,
    'NOT_ISOLATED_TEST_REQUEST')

  // Existing Tasks (even terminal) cannot be reused as a new one-target pilot
  // merely by changing the agent revision or idempotency key.
  const { data: priorTasks, error: otherTaskError } = await db
    .from('ai_agent_tasks').select('id')
    .eq('account_id', accountId)
    .contains('task_context', { coverageRequestId: TEST_REQUEST })
    .neq('id', taskId).limit(2)
  if (otherTaskError) throw otherTaskError
  must(priorTasks?.length === 0, 'REQUEST_HAS_ANOTHER_TASK')
  must(task.max_targets === 1 && task.max_attempts_per_target === 1, 'TASK_LIMIT_NOT_ONE')
  const contactId = policy.selectedContactId
  const connectionId = policy.whatsappConnectionId
  must(typeof contactId === 'string' && UUID_RE.test(contactId), 'CONTACT_NOT_FROZEN')
  must(typeof connectionId === 'string' && UUID_RE.test(connectionId), 'CONNECTION_NOT_FROZEN')
  must(contactId === TEST_CONTACT && connectionId === TEST_CONNECTION &&
    fixture?.requester_contact_id !== contactId, 'WRONG_TEST_RECIPIENT_OR_SESSION')
  const { data: supplierHistory, error: supplierError } = await db.from('coverage_offers')
    .select('id,provider_contact_id,status').eq('account_id', accountId)
    .eq('service_id', TEST_SERVICE).eq('currency','SAR')
    .in('status',['active','partially_reserved','fully_reserved','fulfilled','expired'])
    .limit(3)
  if (supplierError) throw supplierError
  must(supplierHistory?.length === 1 &&
    supplierHistory[0].provider_contact_id === TEST_CONTACT &&
    supplierHistory[0].status === 'fulfilled', 'NOT_SOLE_TEST_SUPPLIER')
  // A supplier can match Coverage history yet be temporarily ineligible
  // because this *same contact* was targeted by an earlier Task. Check the
  // exact 60-minute DB cooldown before the irreversible worker claim, so
  // a TEST operator sees the block instead of generating a false failure.
  if (stageName === 'prepare') {
    const cooldownMinutes = policy.cooldownMinutes
    must(typeof cooldownMinutes === 'number' &&
      Number.isInteger(cooldownMinutes) && cooldownMinutes >= 0 &&
      cooldownMinutes <= 525600, 'COOLDOWN_POLICY_INVALID')
    if (cooldownMinutes > 0) {
      const { data: priorTargets, error: priorError } = await db
        .from('ai_agent_task_targets')
        .select('id,created_at,last_attempt_at,first_contacted_at')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .neq('task_id', taskId)
        .order('created_at', { ascending: false })
        .limit(100)
      if (priorError) throw priorError
      must((priorTargets ?? []).length < 100, 'COOLDOWN_HISTORY_TRUNCATED')
      for (const prior of priorTargets ?? []) {
        const timestamps = [
          prior.first_contacted_at ?? prior.created_at,
          prior.last_attempt_at ?? prior.created_at,
          prior.created_at,
        ].map((value: string) => Date.parse(value))
        must(timestamps.every(Number.isFinite), 'COOLDOWN_TIMESTAMP_INVALID')
        const safeAt = Math.max(...timestamps) + cooldownMinutes * 60_000
        must(safeAt <= Date.now(),
          'CONTACT_COOLDOWN_ACTIVE_UNTIL_' + new Date(safeAt).toISOString())
      }
    }
  }

  must(task.status === (stageName === 'prepare' ? 'queued' : 'running'), 'UNEXPECTED_TASK_STATUS')
  if (stageName === 'prepare') must(typeof task.available_at === 'string' && task.available_at <= now, 'NOT_DUE')

  const readiness = await inspectAgentTaskTestCutoverReadiness({ accountId })
  must(readiness.mode === 'pilot' && readiness.runtime.outboundTaskDeliveryEnabled &&
    readiness.whatsappScope.enabled && !readiness.runtime.killSwitch, 'CUTOVER_NOT_PILOT')
  must(readiness.counts.reconciliationMessages === 0 &&
    readiness.counts.sendingMessages === 0 && readiness.counts.openWhatsappCircuits === 0,
    'IN_FLIGHT_OR_UNCERTAIN_DELIVERY')

  const { data: revision, error: revError } = await db.from('ai_agent_revisions')
    .select('status,outreach_policy').eq('account_id', accountId)
    .eq('id', String(task.agent_revision_id)).maybeSingle()
  if (revError) throw revError
  const rev = fields(revision)
  const outreach = fields(rev.outreach_policy)
  const bindings = outreach.bindings
  must(rev.status === 'published' && Array.isArray(bindings) &&
    bindings.some(x => {
      const b = x && typeof x === 'object' ? x as Record<string, unknown> : {}
      return b.taskType === 'coverage.sourcing' && b.taskTypeVersion === 2 && b.maxFollowups === 0
    }), 'PUBLISHED_NO_FOLLOWUPS_REQUIRED')

  const { data: rawConn, error: connectionError } = await db.from('whatsapp_connections')
    .select('id,provider,status,archived_at,session_id')
    .eq('account_id', accountId).eq('id', connectionId).maybeSingle()
  if (connectionError) throw connectionError
  const conn = fields(rawConn)
  must(conn.provider === 'openwa' && conn.status === 'ready' &&
    conn.archived_at === null && !!conn.session_id, 'OPENWA_CONNECTION_NOT_READY')

  const { data: rawGuard, error: guardError } = await db.from('whatsapp_connection_guardrails')
    .select('pilot_enabled,manual_paused,hourly_cap,daily_cap,first_touch_daily_cap,warmup_hourly_cap,warmup_daily_cap,warmup_until,circuit_open_until')
    .eq('account_id', accountId).eq('connection_id', connectionId).maybeSingle()
  if (guardError) throw guardError
  const guard = fields(rawGuard)
  // The operator deliberately disabled this connection's OpenWA Pilot
  // on the pinned TEST project. Keep the separate, more restrictive SOF-63
  // one-target/one-attempt acceptance fence, without silently reenabling
  // Pilot or widening the original account, service or recipient identity.
  // Even with Pilot off, the transport still enforces all connection
  // guardrail capacity limits, pause/circuit and signing boundaries.
  const pilotEnabled = guard.pilot_enabled
  must(typeof pilotEnabled === 'boolean', 'OPENWA_PILOT_STATE_UNKNOWN')
  must(guard.manual_paused === false && guard.circuit_open_until === null &&
    typeof guard.hourly_cap === 'number' && guard.hourly_cap >= 1 && guard.hourly_cap <= 60 &&
    typeof guard.daily_cap === 'number' && guard.daily_cap >= 1 && guard.daily_cap <= 500 &&
    typeof guard.first_touch_daily_cap === 'number' &&
    guard.first_touch_daily_cap >= 1 && guard.first_touch_daily_cap <= 100 &&
    typeof guard.warmup_hourly_cap === 'number' &&
    guard.warmup_hourly_cap >= 1 && guard.warmup_hourly_cap <= 60 &&
    typeof guard.warmup_daily_cap === 'number' &&
    guard.warmup_daily_cap >= 1 && guard.warmup_daily_cap <= 500,
    'OPENWA_TEST_SESSION_GUARDRAILS_OUT_OF_BOUNDS')

  // This previously verified signed, *historical* agent grant identifies
  // the operator's ONE owned TEST recipient even when an admin has revoked
  // Pilot and the grant itself is inactive. It does not authorize outreach
  // to a new number. Verify the hash against a recent same-session inbound
  // below; a revoked historical grant is never an admission token for the
  // provider when Pilot is enabled.
  const { data: grants, error: grantsError } = await db.from('whatsapp_openwa_pilot_allowlist')
    .select('workload,recipient_hash,active,expires_at')
    .eq('account_id', accountId).eq('connection_id', connectionId)
    .eq('workload', 'agent').limit(2)
  if (grantsError) throw grantsError
  const grant = grants?.[0]
  must(grants?.length === 1 && grant?.workload === 'agent' &&
    typeof grant.recipient_hash === 'string' && grant.recipient_hash.length === 64,
    'NOT_EXACTLY_ONE_HISTORIC_TEST_RECIPIENT')
  assertScopedOpenWATestPilotMode({
    pilotEnabled,
    acknowledgment: process.env.WACRM_AGENT_TASK_ONE_TARGET_PILOT_OFF_ACK,
    grant: { active: grant.active === true,
      expiresAt: typeof grant.expires_at === 'string' ? grant.expires_at : null },
    nowMs: Date.now(),
  })

  // Verify the sole grant belongs to the chosen account contact's *real*
  // inbound chat on this exact frozen OpenWA connection, not just any TEST JID.
  const { data: convs, error: convError } = await db.from('conversations')
    .select('id').eq('account_id', accountId).eq('contact_id', contactId).limit(100)
  if (convError) throw convError
  const convIds = (convs ?? []).map(x => x.id)
  must(convIds.length > 0, 'SELECTED_CONTACT_NO_CONVERSATION')
  const { data: inbound, error: inboundError } = await db.from('messages')
    .select('provider_chat_id')
    .in('conversation_id', convIds)
    .eq('connection_id', connectionId).eq('provider', 'openwa')
    .eq('sender_type', 'customer')
    .gte('created_at', new Date(Date.now()-24*3600_000).toISOString())
    .order('created_at', { ascending: false }).limit(100)
  if (inboundError) throw inboundError
  must((inbound ?? []).some(msg => {
    if (typeof msg.provider_chat_id !== 'string') return false
    const hash = createHash('sha256')
      .update('openwa-pilot:v1:' + accountId + ':' + connectionId + ':' + msg.provider_chat_id)
      .digest('hex')
    return hash === grant.recipient_hash
  }), 'GRANT_NOT_SELECTED_RECIPIENT')

  const { data: reserved, error: reservedError } = await db
    .from('ai_agent_task_outbound_messages')
    .select('id,status').eq('account_id', accountId)
    .eq('task_id', taskId).limit(2)
  if (reservedError) throw reservedError
  must(reserved?.length === 0, 'RESERVATION_EXISTS_DO_NOT_RETRY')

  const { data: globallyUnsettled, error: ambiguousError } = await db
    .from('ai_agent_task_outbound_messages').select('id,status')
    .in('status', ['reserved','sending','requires_reconciliation'])
    .limit(2)
  if (ambiguousError) throw ambiguousError
  must(globallyUnsettled?.length === 0, 'GLOBAL_UNSETTLED_SEND_DO_NOT_TICK')

  const { data: targetRows, error: targetsError } = await db
    .from('ai_agent_task_targets').select('id,contact_id,task_id')
    .eq('account_id', accountId).eq('task_id', taskId).limit(2)
  if (targetsError) throw targetsError
  const { data: runRows, error: runError } = await db
    .from('ai_agent_runs').select('id,account_id,status,run_mode,task_id,task_target_id')
    .eq('account_id', accountId).eq('task_id', taskId).limit(2)
  if (runError) throw runError

  if (stageName === 'prepare') {
    must(targetRows?.length === 0 && runRows?.length === 0, 'PREPARE_ALREADY_PROGRESSING')
    const { data: dueTasks, error: dueError } = await db.from('ai_agent_tasks')
      .select('id').in('status', ['queued','scheduled','running'])
      .lte('available_at', now).limit(2)
    if (dueError) throw dueError
    must(dueTasks?.length === 1 && dueTasks[0].id === taskId, 'OTHER_AGENT_TASKS_DUE')
    const { data: otherRuns, error: pendingError } = await db.from('ai_agent_runs')
      .select('id').eq('run_mode','outbound').eq('status','queued')
      .lte('available_at',now).limit(2)
    if (pendingError) throw pendingError
    must(otherRuns?.length === 0, 'OTHER_OUTBOUND_RUNS_DUE')
  } else {
    must(targetRows?.length === 1 &&
      targetRows[0].contact_id === contactId &&
      runRows?.length === 1 &&
      runRows[0].run_mode === 'outbound' && runRows[0].status === 'queued' &&
      runRows[0].task_target_id === targetRows[0].id,
      'TARGET_OR_RUN_NOT_EXCLUSIVE')
    const { data: dueRuns, error: dueRunsError } = await db.from('ai_agent_runs')
      .select('id,task_id').eq('run_mode','outbound').eq('status','queued')
      .lte('available_at',now).limit(2)
    if (dueRunsError) throw dueRunsError
    must(dueRuns?.length === 1 && dueRuns[0].task_id === taskId, 'OTHER_OUTBOUND_RUNS_DUE')
  }

  if (stageName === 'send') {
    // Guardrail SQL counts every workload's "reserved" event in the rolling
    // hour/day. Do this BEFORE a Run is claimed or an outbound reservation is
    // made; the guardrail RPC is still the authoritative atomic gate.
    const { data: history, error: historyError } = await db
      .from('whatsapp_guardrail_events')
      .select('created_at')
      .eq('account_id', accountId)
      .eq('connection_id', connectionId)
      .eq('decision', 'reserved')
      .gte('created_at', new Date(Date.now() - 86_400_000).toISOString())
      .order('created_at', { ascending: true })
      .limit(1000)
    if (historyError) throw historyError
    must((history ?? []).length < 1000, 'GUARDRAIL_HISTORY_TRUNCATED')
    const warmupActive = typeof guard.warmup_until === 'string' &&
      Date.parse(guard.warmup_until) > Date.now()
    const hourlyCap = warmupActive
      ? Math.min(Number(guard.hourly_cap),Number(guard.warmup_hourly_cap))
      : Number(guard.hourly_cap)
    const dailyCap = warmupActive
      ? Math.min(Number(guard.daily_cap),Number(guard.warmup_daily_cap))
      : Number(guard.daily_cap)
    const availability = inspectOpenWAGuardrailReservationWindow({
      nowMs: Date.now(), hourlyCap, dailyCap,
      reservedAt: (history ?? []).map(x => x.created_at),
    })
    must(availability.allowed,
      'OPENWA_' + (availability.allowed ? '' : availability.quota.toUpperCase()) +
      '_EXHAUSTED_UNTIL_' + (availability.allowed ? '' : availability.availableAt))
  }

  return { accountId, taskId, contactId, connectionId, db }
}

/**
 * Close an exhausted, unsent TEST Task using the existing domain completion
 * policy. It never calls either worker and never creates a new attempt.
 * The only permitted prior failure is the observed pre-reservation handoff.
 */
async function finalizeFailedHandoffTask(): Promise<void> {
  const { accountId, taskId } = accountConfig()
  const db = supabaseAdmin()
  const { data: task, error: taskError } = await db.from('ai_agent_tasks')
    .select('id,status,task_type,task_type_version,task_context')
    .eq('account_id', accountId).eq('id', taskId).maybeSingle()
  if (taskError) throw taskError
  const row = fields(task)
  const context = fields(row.task_context)
  must(row.status === 'running' &&
    row.task_type === 'coverage.sourcing' &&
    row.task_type_version === 2 &&
    context.coverageRequestId === HISTORICAL_FAILED_REQUEST, 'FINALIZE_UNEXPECTED_TASK')

  const [{ data: targets, error: targetError },
    { data: runs, error: runError },
    { data: reservations, error: reservationsError }] = await Promise.all([
    db.from('ai_agent_task_targets').select('id,status,attempt_count,failure_code')
      .eq('account_id',accountId).eq('task_id',taskId).limit(2),
    db.from('ai_agent_runs').select('id,status,attempt_count,error_code')
      .eq('account_id',accountId).eq('task_id',taskId)
      .eq('run_mode','outbound').limit(2),
    db.from('ai_agent_task_outbound_messages').select('id')
      .eq('account_id',accountId).eq('task_id',taskId).limit(1),
  ])
  if (targetError) throw targetError
  if (runError) throw runError
  if (reservationsError) throw reservationsError
  must(reservations?.length === 0, 'FINALIZE_RESERVATION_EXISTS')
  must(targets?.length === 1 && targets[0].status === 'exhausted' &&
    targets[0].attempt_count === 1 &&
    targets[0].failure_code === 'AGENT_OUTBOUND_NEEDS_HUMAN',
    'FINALIZE_TARGET_NOT_EXPECTED_FAILURE')
  must(runs?.length === 1 && runs[0].status === 'failed' &&
    runs[0].attempt_count === 1 &&
    runs[0].error_code === 'AGENT_OUTBOUND_NEEDS_HUMAN',
    'FINALIZE_RUN_NOT_EXPECTED_FAILURE')
  const completion = await evaluateCurrentTaskCompletion(taskId)
  expect(completion.finalized).toBe(true)
  expect(completion.status).toBe('partially_completed')
  expect(completion.reason).toBe('supplier_targets_exhausted')
  const { data: remaining, error: verifyError } = await db.from('ai_agent_tasks')
    .select('status').eq('account_id', accountId).eq('id',taskId).maybeSingle()
  if (verifyError) throw verifyError
  expect(remaining?.status).toBe('partially_completed')
  console.info('SOF63 FINALIZED: exhausted unsent Task closed; no send, no retry.')
}

(enabled ? describe : describe.skip)('SOF-63 scoped TEST-only worker', () => {
  it('runs precisely the approved stage; the generic worker is never called', async () => {
    must(stage === 'prepare' || stage === 'send' || stage === 'finalize_failed', 'STAGE_REQUIRED')
    if (stage === 'finalize_failed') {
      must(process.env.WACRM_AGENT_TASK_ONE_TARGET_CONFIRM === 'FINALIZE_FAILED_NO_SEND',
        'FINALIZE_EXPLICIT_CONFIRM_REQUIRED')
      await finalizeFailedHandoffTask()
      return
    }
    const confirmed = stage === 'prepare'
      ? 'PREPARE_ONE_TARGET_NO_SEND'
      : 'SEND_ONE_TARGET_TEST_NOW'
    must(process.env.WACRM_AGENT_TASK_ONE_TARGET_CONFIRM === confirmed,
      'EXPLICIT_CONFIRM_REQUIRED')
    const scope = await loadExclusiveTask(stage)

    if (stage === 'prepare') {
      const result = await processAgentTaskQueue({
        workerId: 'sof63-test-prepare:' + scope.taskId, limit: 1,
      })
      expect(result.failed).toBe(0)
      expect(result.claimedTasks).toBe(1)
      expect(result.materializedTargets).toBe(1)
      expect(result.createdRuns).toBe(1)

      const { data: outboundRuns, error } = await scope.db.from('ai_agent_runs')
        .select('id,task_id,status').eq('account_id',scope.accountId)
        .eq('task_id',scope.taskId).eq('run_mode','outbound').limit(2)
      if (error) throw error
      expect(outboundRuns).toHaveLength(1)
      expect(outboundRuns?.[0].status).toBe('queued')
      console.info('SOF63 PREPARED: one target, one queued run; no WhatsApp send.')
      return
    }

    const result = await processAgentTaskOutboundRunQueue({
      workerId: 'sof63-test-send:' + scope.taskId, limit: 1,
    })
    console.info('SOF63 SEND RESULT:', JSON.stringify(result))
    // If the provider accepted a send but outcome is ambiguous, do NOT
    // repeat this stage. Inspect the frozen reservation and reconcile.
    expect(result.scanned).toBe(1)
    expect(result.attempted).toBe(1)
    expect(result.sent).toBe(1)
    expect(result.reconciliation).toBe(0)
    expect(result.failed).toBe(0)
  }, 180_000)
})
