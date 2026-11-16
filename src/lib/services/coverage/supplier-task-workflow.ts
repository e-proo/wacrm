import { supabaseAdmin } from '@/lib/ai/admin-client'
import { CURRENT_AGENT_TASK_PLATFORM } from '@/lib/ai/tasks/current-platform'
import { authorizeStoredAgentTask } from '@/lib/ai/tasks/capability-policy'
import { executeCoverageProposeOfferIntegrated } from '@/lib/ai/tools/business-handoff'
import { loadAccountRuntimePolicy } from '@/lib/ai/runtime/runtime-policy'
import { findChangeRequestByIdempotencyKey } from '@/lib/ai/runtime/change-requests-service'
import type { ToolContext } from '@/lib/ai/tools/executors'
import { readCoverageAttributes } from './attributes'
import {
  advanceSupplierTurn, initialSupplierState, parseSupplierNumber, supplierAffirms,
  type SupplierStage, type SupplierTurnState,
} from './supplier-task-dialogue'

type Db = ReturnType<typeof supabaseAdmin>
interface TaskSupplierRow {
  account_id: string; task_id: string; task_target_id: string
  contact_id: string; conversation_id: string; stage: SupplierStage
  offered_amount: string | null
  commission_per_thousand: string | null; supplier_details: string | null
  version: number; last_inbound_message_id: string | null
  confirmation_message_id: string | null
  confirmation_run_id: string | null
  change_request_id: string | null
}
export interface SupplierTaskReply {
  text: string
  outcome?: { outcome: 'declined'; detail: string }
}
export interface SupplierReplyInput {
  accountId: string; taskId: string; taskTargetId: string; runId: string
  contactId: string | null; conversationId: string; sourceMessageId: string
}

/** Source of truth is the Task's frozen target and Coverage Request, NOT
 * claims made by the supplier/model about who owns the contact or direction. */
async function verifiedSupplierContext(db: Db, input: SupplierReplyInput) {
  const { data: task, error: te } = await db.from('ai_agent_tasks')
    .select('id,task_type,task_type_version,status,task_context')
    .eq('account_id', input.accountId).eq('id', input.taskId).maybeSingle()
  if (te) throw te
  if (!task || task.task_type !== 'coverage.sourcing' || task.task_type_version !== 2) return null
  if (task.status !== 'running') throw new Error('SUPPLIER_TASK_NOT_RUNNING')
  const { data: target, error: ta } = await db.from('ai_agent_task_targets')
    .select('id,contact_id,conversation_id,status')
    .eq('account_id', input.accountId).eq('task_id', input.taskId)
    .eq('id', input.taskTargetId).maybeSingle()
  if (ta) throw ta
  if (!input.contactId || !target || target.contact_id !== input.contactId ||
      target.conversation_id !== input.conversationId ||
      !['replied','awaiting_reply','in_progress'].includes(target.status)) {
    throw new Error('SUPPLIER_TARGET_BINDING_MISMATCH')
  }
  const { data: run, error: re } = await db.from('ai_agent_runs')
    .select('id,status,run_mode,task_id,task_target_id,conversation_id,inbound_message_id')
    .eq('account_id', input.accountId).eq('id', input.runId).maybeSingle()
  if (re) throw re
  if (!run || run.status !== 'claimed' || run.run_mode !== 'inbound' ||
      run.task_id !== input.taskId || run.task_target_id !== input.taskTargetId ||
      run.conversation_id !== input.conversationId ||
      run.inbound_message_id !== input.sourceMessageId) {
    throw new Error('SUPPLIER_INBOUND_RUN_BINDING_MISMATCH')
  }
  const { data: inbound, error: ie } = await db.from('messages')
    .select('id,created_at,sender_type,content_text')
    .eq('conversation_id', input.conversationId)
    .eq('id', input.sourceMessageId).maybeSingle()
  if (ie) throw ie
  if (!inbound || inbound.sender_type !== 'customer') {
    throw new Error('SUPPLIER_INBOUND_MESSAGE_MISMATCH')
  }
  const requestId = (task.task_context as Record<string, unknown> | null)?.coverageRequestId
  if (typeof requestId !== 'string') throw new Error('SUPPLIER_REQUEST_NOT_BOUND')
  const { data: request, error: qe } = await db.from('coverage_requests')
    .select('id,service_id,currency,status,requested_amount,reserved_amount,fulfilled_amount,attributes')
    .eq('account_id', input.accountId).eq('id', requestId).maybeSingle()
  if (qe) throw qe
  if (!request || !['active','partially_reserved'].includes(request.status)) {
    throw new Error('SUPPLIER_SOURCE_REQUEST_NOT_ACTIVE')
  }
  const remaining = Math.max(
    Number(request.requested_amount) -
      Number(request.reserved_amount) - Number(request.fulfilled_amount), 0,
  )
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new Error('SUPPLIER_SOURCE_REQUEST_SATISFIED')
  }
  return {
    inbound,
    request: {
      id: request.id, serviceId: request.service_id, currency: request.currency,
      remainingAmount: String(remaining),
      attributes: readCoverageAttributes(request.attributes),
    },
  }
}

async function loadOrCreateNegotiation(db: Db, input: SupplierReplyInput): Promise<TaskSupplierRow> {
  const initial = {
    account_id: input.accountId, task_id: input.taskId,
    task_target_id: input.taskTargetId, contact_id: input.contactId,
    conversation_id: input.conversationId, stage: 'availability' as const,
  }
  const { error: insertError } = await db.from('ai_agent_coverage_supplier_negotiations')
    .upsert(initial, { onConflict: 'account_id,task_id,task_target_id', ignoreDuplicates: true })
  if (insertError) throw insertError
  const { data, error } = await db.from('ai_agent_coverage_supplier_negotiations')
    .select('*').eq('account_id', input.accountId).eq('task_id', input.taskId)
    .eq('task_target_id', input.taskTargetId).maybeSingle()
  if (error) throw error
  if (!data || data.contact_id !== input.contactId ||
      data.conversation_id !== input.conversationId) {
    throw new Error('SUPPLIER_NEGOTIATION_SCOPE_MISMATCH')
  }
  return data as TaskSupplierRow
}

async function saveStep(
  db: Db, input: SupplierReplyInput, row: TaskSupplierRow,
  next: SupplierTurnState,
): Promise<boolean> {
  const { data, error } = await db.from('ai_agent_coverage_supplier_negotiations')
    .update({
      stage: next.stage,
      offered_amount: next.offeredAmount,
      commission_per_thousand: next.commissionPerThousand,
      supplier_details: next.supplierDetails,
      version: row.version + 1,
      last_inbound_message_id: input.sourceMessageId,
      ...(next.stage === 'submitting'
        ? { confirmation_message_id: input.sourceMessageId, confirmation_run_id: input.runId }
        : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('account_id', input.accountId)
    .eq('task_id', input.taskId).eq('task_target_id', input.taskTargetId)
    .eq('version', row.version).select('version').maybeSingle()
  if (error) throw error
  return data?.version === row.version + 1
}

async function legacyCommissionConfirmation(db: Db, input: SupplierReplyInput,
  inboundCreatedAt: string, raw: string): Promise<string | null> {
  if (!supplierAffirms(raw)) return null
  const { data, error } = await db.from('messages')
    .select('content_text')
    .eq('conversation_id', input.conversationId).eq('sender_type', 'bot')
    .lt('created_at', inboundCreatedAt)
    .order('created_at', { ascending: false }).limit(1)
  if (error) throw error
  const previous = data?.[0]?.content_text ?? ''
  if (!previous.includes('العمولة') || !previous.includes('1000')) return null
  const found = /العمولة[^0-9٠-٩]{0,30}([0-9٠-٩۰-۹]+(?:[.٫][0-9٠-٩۰-۹]+)?)\s*لكل\s*(?:1000|١٠٠٠)/.exec(previous)
  return found ? parseSupplierNumber(found[1], 1000, true) : null
}

function supplierToolContext(input: SupplierReplyInput): ToolContext {
  return {
    accountId: input.accountId, actorUserId: null, runId: input.runId,
    grants: { 'coverage.propose_offer': 'propose' },
    grantVersions: { 'coverage.propose_offer': 2 }, grantConstraints: {},
    plane: 'customer', channel: 'whatsapp', simulation: false,
    trustedAdminIdentityId: null, trustedAdminCapabilities: [],
    agentCapabilities: ['coverage.propose','coverage.sourcing'],
    taskAllowedTools: [{ key: 'coverage.propose_offer', version: 2 }],
    agentPurpose: 'custom', contactId: input.contactId,
    conversationId: input.conversationId, sourceMessageId: input.sourceMessageId,
    features: { killSwitch: false, nativeToolsEnabled: true, proposalToolsEnabled: true },
  }
}

async function submitConfirmedOffer(
  db: Db, input: SupplierReplyInput, row: TaskSupplierRow,
  request: NonNullable<Awaited<ReturnType<typeof verifiedSupplierContext>>>['request'],
): Promise<SupplierTaskReply> {
  // Do not bypass the frozen published agent's capability/grant revocation.
  const authorization = await authorizeStoredAgentTask(db, {
    taskId: input.taskId, taskTypes: CURRENT_AGENT_TASK_PLATFORM.taskTypes,
  })
  if (!authorization.ok ||
      !authorization.capabilities.includes('coverage.propose') ||
      !authorization.allowedTools.some(t =>
        t.key === 'coverage.propose_offer' && t.version === 2)) {
    throw new Error('SUPPLIER_PROPOSAL_GRANT_DENIED')
  }
  const runtime = await loadAccountRuntimePolicy(db, input.accountId)
  if (runtime.killSwitch || !runtime.nativeToolsEnabled ||
      !runtime.proposalToolsEnabled) {
    throw new Error('SUPPLIER_PROPOSAL_RUNTIME_DISABLED')
  }
  if (!row.offered_amount || !row.commission_per_thousand || !row.supplier_details) {
    // A zero commission is stored as string "0", which is truthy.
    throw new Error('SUPPLIER_PROPOSAL_INCOMPLETE')
  }
  if (Number(row.offered_amount) > Number(request.remainingAmount)) {
    throw new Error('SUPPLIER_OFFER_EXCEEDS_REQUEST_REMAINING')
  }
  const source = request.attributes
  if (!source.pay_region_id || !source.receive_region_id) {
    throw new Error('SUPPLIER_COVERAGE_DIRECTION_UNRESOLVED')
  }
  const inverted = {
    coverage_scope: source.coverage_scope,
    coverage_country: source.coverage_country,
    pay_region_id: source.receive_region_id,
    receive_region_id: source.pay_region_id,
    pay_method: source.receive_method,
    receive_method: source.pay_method,
  }
  const proposalKey = `coverage-sourcing:${input.taskId}:${input.taskTargetId}`
  const prior = await findChangeRequestByIdempotencyKey(input.accountId, proposalKey)
  if (prior) {
    const pay = prior.proposed_payload ?? {}
    if (prior.action_key !== 'coverage.offer.create' ||
        pay.contact_id !== input.contactId ||
        pay.source_task_target_id !== input.taskTargetId ||
        pay.source_task_id !== input.taskId ||
        pay.source_coverage_request_id !== request.id) {
      throw new Error('SUPPLIER_PROPOSAL_IDEMPOTENCY_MISMATCH')
    }
    await db.from('ai_agent_coverage_supplier_negotiations')
      .update({ stage: 'submitted', change_request_id: prior.id, updated_at: new Date().toISOString() })
      .eq('account_id', input.accountId).eq('task_id', input.taskId)
      .eq('task_target_id', input.taskTargetId).eq('stage', 'submitting')
    return { text: `تم تسجيل العرض سابقًا لدى الإدارة برقم CHG-${prior.code}. حالته ${prior.status}؛ لن نكرر تقديمه.` }
  }
  const outcome = await executeCoverageProposeOfferIntegrated(
    supplierToolContext(input), {
      service_id: request.serviceId,
      total_amount: row.offered_amount,
      currency: request.currency,
      commission_per_thousand: row.commission_per_thousand,
      commission_currency: request.currency,
      attributes: inverted,
      supplier_task: {
        task_id: input.taskId, task_target_id: input.taskTargetId,
        source_request_id: request.id, supplier_details: row.supplier_details,
      },
    },
  )
  if (!outcome.ok) throw new Error(outcome.code ?? 'SUPPLIER_OFFER_PROPOSAL_FAILED')
  const payload = outcome.data as { change_request?: { id?: string; code?: number; status?: string } } | null
  const id = payload?.change_request?.id
  if (!id) throw new Error('SUPPLIER_OFFER_PROPOSAL_NOT_PERSISTED')
  const { error } = await db.from('ai_agent_coverage_supplier_negotiations')
    .update({ stage: 'submitted', change_request_id: id, updated_at: new Date().toISOString() })
    .eq('account_id', input.accountId).eq('task_id', input.taskId)
    .eq('task_target_id', input.taskTargetId).eq('stage', 'submitting')
    .eq('confirmation_message_id', input.sourceMessageId)
  if (error) throw error
  return {
    text: `تم تسجيل عرض التغطية رقم CHG-${payload?.change_request?.code ?? '—'} ورفعه للإدارة للمراجعة. سيتم التواصل معك بعد قرار الإدارة؛ العرض ليس معتمدًا بعد. شكرًا لتعاونك.`,
  }
}

export async function handleCoverageSupplierTaskReply(
  input: SupplierReplyInput,
): Promise<SupplierTaskReply | null> {
  const db = supabaseAdmin()
  const verified = await verifiedSupplierContext(db, input)
  if (!verified) return null // non-Coverage Task, including historic v1
  const raw = (verified.inbound.content_text ?? '').trim()
  if (/^(إيقاف|stop|unsubscribe)$/i.test(raw)) return null // preserve platform opt-out routing
  const row = await loadOrCreateNegotiation(db, input)
  if (row.last_inbound_message_id === input.sourceMessageId) {
    return { text: 'تم تسجيل ردك. لن يُنشأ طلب إداري مكرر.' }
  }
  if (row.stage === 'submitted' && row.change_request_id) {
    const { data: cr, error } = await db.from('change_requests')
      .select('code,status').eq('account_id', input.accountId)
      .eq('id', row.change_request_id).maybeSingle()
    if (error) throw error
    return { text: cr?.status === 'executed'
      ? `اعتمدت الإدارة عرضك CHG-${cr.code} وتم إنشاء عرض تغطية في النظام. سيتم التواصل معك لاستكمال الإجراءات.`
      : cr?.status === 'rejected' || cr?.status === 'cancelled'
        ? `عرض التغطية CHG-${cr.code} لم يُعتمد. يرجى التواصل مع الإدارة لمراجعة التفاصيل.`
        : `عرضك CHG-${cr?.code ?? '—'} ما زال قيد مراجعة الإدارة، وسيتم التواصل معك بعد القرار.` }
  }
  let current: SupplierTurnState = {
    stage: row.stage, offeredAmount: row.offered_amount,
    commissionPerThousand: row.commission_per_thousand,
    supplierDetails: row.supplier_details,
  }
  // Backward-compatible continuation: old GPT loop may have asked the seller
  // to confirm "7 لكل 1000" before the durable protocol existed. Reuse ONLY
  // the supplier's explicit affirmative and that prior visible question,
  // never assume their covered amount or unspoken settlement terms.
  if (row.version === 0 && current.stage === 'availability') {
    const commission = await legacyCommissionConfirmation(
      db, input, verified.inbound.created_at, raw,
    )
    if (commission !== null) current = { ...current, commissionPerThousand: commission }
  }
  const step = advanceSupplierTurn(current, raw, {
    remainingAmount: verified.request.remainingAmount, currency: verified.request.currency,
  })
  if (!(await saveStep(db, input, row, step.next))) {
    throw new Error('SUPPLIER_NEGOTIATION_CONCURRENT_UPDATE')
  }
  if (step.action === 'submit') {
    try {
      return await submitConfirmedOffer(db, input,
        { ...row, stage: step.next.stage, offered_amount: step.next.offeredAmount,
          commission_per_thousand: step.next.commissionPerThousand,
          supplier_details: step.next.supplierDetails }, verified.request)
    } catch (error) {
      console.error('[coverage supplier task] proposal failed', {
        task: input.taskId.slice(0, 8),
        code: error instanceof Error ? error.message : 'unknown',
      })
      await db.from('ai_agent_coverage_supplier_negotiations')
        .update({ stage: 'needs_human', updated_at: new Date().toISOString() })
        .eq('account_id', input.accountId).eq('task_id', input.taskId)
        .eq('task_target_id', input.taskTargetId).eq('stage', 'submitting')
      return { text: 'استلمنا تأكيدك، لكن تعذر تسجيل عرض التغطية للإدارة تلقائيًا. يحتاج الطلب إلى متابعة بشرية؛ لن نعتبره معتمدًا أو مرفوعًا حتى نتحقق.' }
    }
  }
  return {
    text: step.response,
    ...(step.action === 'decline'
      ? { outcome: { outcome: 'declined' as const, detail: 'Supplier declined the frozen Coverage Request.' } }
      : {}),
  }
}
