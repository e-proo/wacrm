import { supabaseAdmin } from '../admin-client'
import { loadAccountRuntimePolicy } from './runtime-policy'
import { sweepAgentRuns } from './recovery'
import { resumeQueuedAgentRun } from './dispatch'
import { engineSendText } from '@/lib/automations/meta-send'
import { randomUUID } from 'crypto'
import { executeApprovedChangeRequest } from './change-request-executor'
import {
  renderFxTradeCustomerMessage,
  type FxTradeCustomerOutcome,
} from '@/lib/messaging/fx-v2-customer'
import { createSupabaseTemplateOverrideStore } from '@/lib/messaging/supabase-store'

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

interface CustomerNotificationCandidate {
  id: string
  account_id: string
  contact_id: string
  conversation_id: string | null
  message_text: string
  attempts: number
  fx_trade_request_id: string | null
  event_type: string
}

/**
 * One bounded worker tick for durable customer business events.
 *
 * The historical table name `customer_intent_notifications` is retained for
 * compatibility, but Phase 6 also stores FX V2 lifecycle events there. FX rows
 * are rendered immediately before transport from the immutable trade snapshot;
 * the internal outbox marker is never customer-facing text.
 */
export async function processCustomerIntentNotifications(input: {
  limit?: number
}): Promise<NotificationWorkerResult> {
  const db = supabaseAdmin()
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100))
  const { data: candidates, error } = await db
    .from('customer_intent_notifications')
    .select('id, account_id, contact_id, conversation_id, message_text, attempts, fx_trade_request_id, event_type')
    .eq('status', 'pending')
    .lte('available_at', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) throw error

  let attempted = 0
  let sent = 0
  let requiresReconciliation = 0
  let failed = 0
  let skippedByPolicy = 0
  for (const raw of candidates ?? []) {
    const row = raw as CustomerNotificationCandidate
    const policy = await loadAccountRuntimePolicy(db, row.account_id)
    // This switch controls durable worker activity. The AI kill switch does
    // not suppress a deterministic result notification for a business change
    // that a human already approved and the executor already applied.
    if (!policy.recoveryWorkerEnabled) {
      skippedByPolicy += 1
      continue
    }
    if (!row.conversation_id) {
      await db.from('customer_intent_notifications')
        .update({ status: 'failed', last_error: 'CONVERSATION_MISSING' })
        .eq('id', row.id).eq('status', 'pending')
      failed += 1
      continue
    }
    const claimToken = randomUUID()
    const { data: claimed, error: claimError } = await db
      .from('customer_intent_notifications')
      .update({
        status: 'sending',
        claim_token: claimToken,
        claimed_at: new Date().toISOString(),
        attempts: Number(row.attempts ?? 0) + 1,
      })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (claimError) throw claimError
    if (!claimed) continue
    attempted += 1

    const engineKey = `intent-notification:${row.id}`
    try {
      const { data: conversation, error: convError } = await db
        .from('conversations')
        .select('user_id')
        .eq('id', row.conversation_id)
        .eq('account_id', row.account_id)
        .maybeSingle()
      if (convError) throw convError
      if (!conversation?.user_id) throw new Error('CONVERSATION_OWNER_MISSING')

      const messageText = row.fx_trade_request_id
        ? await renderFxTradeOutboxText({
            accountId: row.account_id,
            tradeRequestId: row.fx_trade_request_id,
            eventType: row.event_type,
          })
        : row.message_text

      const outbound = await engineSendText({
        accountId: row.account_id,
        userId: conversation.user_id,
        conversationId: row.conversation_id,
        contactId: row.contact_id,
        text: messageText,
        engineIdempotencyKey: engineKey,
      })
      const { data: completed, error: completeError } = await db
        .from('customer_intent_notifications')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          local_message_id: outbound.local_message_id,
          last_error: null,
          claim_token: null,
        })
        .eq('id', row.id)
        .eq('status', 'sending')
        .eq('claim_token', claimToken)
        .select('id')
        .maybeSingle()
      if (completeError || !completed) {
        throw completeError ?? new Error('NOTIFICATION_COMPLETION_CAS_LOST')
      }
      sent += 1
    } catch (err) {
      // Once a local outbound reservation exists we never blindly retry Meta:
      // a timeout can happen after Meta accepted the message. If failure occurs
      // before reservation (for example a render/load problem), mark it failed
      // instead of incorrectly requiring transport reconciliation.
      const message = err instanceof Error ? err.message : String(err)
      const { data: localReservation } = await db
        .from('messages')
        .select('id')
        .eq('engine_idempotency_key', engineKey)
        .maybeSingle()
      const requiresReconcile = Boolean(localReservation)

      await db.from('customer_intent_notifications')
        .update({
          status: requiresReconcile ? 'requires_reconciliation' : 'failed',
          local_message_id: localReservation?.id ?? null,
          last_error: message.slice(0, 1000),
          claim_token: null,
        })
        .eq('id', row.id)
        .eq('claim_token', claimToken)

      if (requiresReconcile) requiresReconciliation += 1
      else failed += 1
    }
  }
  return {
    scanned: (candidates ?? []).length,
    attempted,
    sent,
    requiresReconciliation,
    failed,
    skippedByPolicy,
  }
}

async function renderFxTradeOutboxText(input: {
  accountId: string
  tradeRequestId: string
  eventType: string
}): Promise<string> {
  const outcome = fxOutcomeForEvent(input.eventType)
  if (!outcome) throw new Error(`FX_TRADE_NOTIFICATION_EVENT_UNSUPPORTED:${input.eventType}`)

  const db = supabaseAdmin()
  const { data: trade, error: tradeError } = await db
    .from('exchange_trade_requests')
    .select('id, code, pair_id, side, amount_basis, requested_amount, effective_rate, base_amount, quote_amount, rate_version_id')
    .eq('account_id', input.accountId)
    .eq('id', input.tradeRequestId)
    .maybeSingle()
  if (tradeError) throw tradeError
  if (!trade) throw new Error('FX_TRADE_NOTIFICATION_REQUEST_NOT_FOUND')

  const { data: pair, error: pairError } = await db
    .from('exchange_rate_pairs')
    .select('base_currency_id, quote_currency_id')
    .eq('account_id', input.accountId)
    .eq('id', trade.pair_id)
    .maybeSingle()
  if (pairError) throw pairError
  if (!pair) throw new Error('FX_TRADE_NOTIFICATION_PAIR_NOT_FOUND')

  const currencyIds = [pair.base_currency_id, pair.quote_currency_id]
  const { data: currencies, error: currencyError } = await db
    .from('currencies')
    .select('id, code')
    .eq('account_id', input.accountId)
    .in('id', currencyIds)
  if (currencyError) throw currencyError
  const codes = new Map((currencies ?? []).map((currency) => [currency.id, currency.code] as const))
  const baseCurrency = codes.get(pair.base_currency_id)
  const quoteCurrency = codes.get(pair.quote_currency_id)
  if (!baseCurrency || !quoteCurrency) {
    throw new Error('FX_TRADE_NOTIFICATION_CURRENCY_NOT_FOUND')
  }

  const rendered = await renderFxTradeCustomerMessage({
    accountId: input.accountId,
    outcome,
    requestId: trade.id,
    reference: `FX-${trade.code}`,
    side: trade.side as 'customer_buy' | 'customer_sell',
    amountBasis: trade.amount_basis as 'base' | 'quote',
    requestedAmount: String(trade.requested_amount),
    effectiveRate: String(trade.effective_rate),
    baseAmount: String(trade.base_amount),
    quoteAmount: String(trade.quote_amount),
    baseCurrency,
    quoteCurrency,
    rateVersionId: String(trade.rate_version_id),
    store: createSupabaseTemplateOverrideStore(db),
  })

  console.info(
    [
      `[messaging] event=${rendered.eventKey}`,
      `source=${rendered.source}`,
      `template=${rendered.eventKey}`,
      `locale=${rendered.resolvedLocale}`,
      'channel=whatsapp',
      `entity=${trade.id}`,
      rendered.revisionId ? `revision=${rendered.revisionId}` : null,
      rendered.version != null ? `version=${rendered.version}` : null,
      rendered.fallbackReason ? `fallback=${rendered.fallbackReason}` : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' '),
  )

  return rendered.text
}

function fxOutcomeForEvent(eventType: string): FxTradeCustomerOutcome | null {
  switch (eventType) {
    case 'exchange_rate.trade.pending':
      return 'pending_admin'
    case 'exchange_rate.trade.approved_for_contact':
      return 'approved_for_contact'
    case 'exchange_rate.trade.rejected':
      return 'rejected'
    case 'exchange_rate.trade.completed':
      return 'completed'
    default:
      return null
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
