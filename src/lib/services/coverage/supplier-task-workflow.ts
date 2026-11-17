import { supabaseAdmin } from '@/lib/ai/admin-client'
import { CURRENT_AGENT_TASK_PLATFORM } from '@/lib/ai/tasks/current-platform'
import { authorizeStoredAgentTask } from '@/lib/ai/tasks/capability-policy'
import { executeCoverageProposeOfferIntegrated } from '@/lib/ai/tools/business-handoff'
import { loadAccountRuntimePolicy } from '@/lib/ai/runtime/runtime-policy'
import { authorizeToolInvocation } from '@/lib/ai/runtime/tool-policy'
import { getCurrentPlatformTool } from '@/lib/ai/tools/platform/current-domain-registry'
import { findChangeRequestByIdempotencyKey, createChangeRequest } from '@/lib/ai/runtime/change-requests-service'
import type { ToolContext } from '@/lib/ai/tools/executors'
import { readCoverageAttributes, normalizeCoverageAttributes } from './attributes'
import { loadSupplierCoverageRoute, supplierNotesConflictWithRoute, describeSupplierCoverageRoute } from './supplier-request-route'
import { extractSupplierQuote } from './supplier-quote-extraction'
import {
  advanceSupplierTurn, initialSupplierState, parseSupplierNumber, supplierAffirms,
  type SupplierStage, type SupplierTurnState,
} from './supplier-task-dialogue'

function supplierDecimalEquals(first: unknown, second: unknown): boolean {
  const normalize=(value:unknown):string|null=>{
    const s=String(value)
    if (!/^\d{1,12}(?:\.\d{1,4})?$/.test(s)) return null
    return s.replace(/\.0+$/,'').replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'')
  }
  const left=normalize(first),right=normalize(second)
  return left!==null && right!==null && left===right
}

type Db = ReturnType<typeof supabaseAdmin>
interface TaskSupplierRow {
  account_id: string; task_id: string; task_target_id: string
  contact_id: string; conversation_id: string; stage: SupplierStage
  offered_amount: string | null
  commission_per_thousand: string | null; supplier_details: string | null
  route_confirmed: boolean
  route_different: boolean
  version: number; last_inbound_message_id: string | null
  confirmation_message_id: string | null
  confirmation_run_id: string | null
  change_request_id: string | null
  updated_at: string
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
  // Refuse a stale Task whose original request legs were edited after its
  // outreach was authorized. Never silently substitute new route/regions.
  const frozen = (task.task_context as Record<string,unknown> | null)?.request
  const snapshot = frozen && typeof frozen === 'object' && !Array.isArray(frozen)
    ? frozen as Record<string,unknown> : null
  const currentAttributes = normalizeCoverageAttributes(request.attributes)
  if (!currentAttributes.ok) throw new Error('SUPPLIER_SOURCE_ROUTE_INVALID')
  if (snapshot?.attributes) {
    const frozenAttributes = normalizeCoverageAttributes(snapshot.attributes as Record<string,unknown>)
    if (!frozenAttributes.ok ||
        JSON.stringify(frozenAttributes.normalized) !== JSON.stringify(currentAttributes.normalized)) {
      throw new Error('SUPPLIER_FROZEN_ROUTE_CHANGED')
    }
  }
  const route = await loadSupplierCoverageRoute(db,input.accountId,currentAttributes.normalized)
  const { data: regions, error: regionsError } = await db.from('coverage_regions')
    .select('id,name').eq('account_id',input.accountId)
    .eq('status','active').limit(100)
  if (regionsError) throw regionsError
  if (!regions || regions.length >= 100) throw new Error('SUPPLIER_REGIONS_UNRESOLVED')

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
      route, knownRegions: regions,
    },
  }
}

async function loadOrCreateNegotiation(db: Db, input: SupplierReplyInput): Promise<TaskSupplierRow> {
  const initial = {
    account_id: input.accountId, task_id: input.taskId,
    task_target_id: input.taskTargetId, contact_id: input.contactId,
    conversation_id: input.conversationId, stage: 'availability' as const,
    route_confirmed: false,
    route_different: false,
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
      route_confirmed: next.routeConfirmed,
      route_different: next.routeDifferent,
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

/**
 * A process can crash after an idempotent administrative Change Request was
 * written but before the per-target negotiation linked it. Recover only the
 * exact Task-bound, confirmed quote. Never create a second proposal here.
 */
async function recoverExistingSupplierProposal(
  db: Db, input: SupplierReplyInput, row: TaskSupplierRow,
  request: NonNullable<Awaited<ReturnType<typeof verifiedSupplierContext>>>['request'],
): Promise<SupplierTaskReply | null> {
  const key = `coverage-sourcing:${input.taskId}:${input.taskTargetId}`
  const prior = await findChangeRequestByIdempotencyKey(input.accountId, key)
  if (!prior) return null

  const payload = prior.proposed_payload ?? {}
  const terms = payload.supplier_terms && typeof payload.supplier_terms === 'object'
    ? payload.supplier_terms as Record<string, unknown> : {}
  if (!['coverage.offer.create', 'coverage.supplier_counteroffer.review'].includes(prior.action_key ?? '') ||
      payload.contact_id !== input.contactId ||
      payload.conversation_id !== input.conversationId ||
      payload.source_task_id !== input.taskId ||
      payload.source_task_target_id !== input.taskTargetId ||
      payload.source_coverage_request_id !== request.id ||
      payload.service_id !== request.serviceId ||
      !supplierDecimalEquals(payload.total_amount, row.offered_amount) ||
      payload.currency !== request.currency ||
      !supplierDecimalEquals(payload.commission_per_thousand, row.commission_per_thousand) ||
      terms.details !== row.supplier_details ||
      terms.explicitly_confirmed_in_message_id !==
        (row.confirmation_message_id ?? input.sourceMessageId)) {
    throw new Error('SUPPLIER_PROPOSAL_IDEMPOTENCY_MISMATCH')
  }

  if (prior.action_key !== 'coverage.supplier_counteroffer.review' &&
      !row.route_confirmed) throw new Error('SUPPLIER_PROPOSAL_REPLAY_ROUTE_UNVERIFIED')
  if ((prior.action_key === 'coverage.supplier_counteroffer.review') !== row.route_different) {
    throw new Error('SUPPLIER_PROPOSAL_REPLAY_KIND_MISMATCH')
  }
  const { data, error } = await db.from('ai_agent_coverage_supplier_negotiations')
    .update({ stage: 'submitted', change_request_id: prior.id,
      updated_at: new Date().toISOString() })
    .eq('account_id', input.accountId).eq('task_id', input.taskId)
    .eq('task_target_id', input.taskTargetId).eq('stage', 'submitting')
    .eq('confirmation_message_id', row.confirmation_message_id ?? input.sourceMessageId)
    .select('change_request_id').maybeSingle()
  if (error) throw error
  if (data?.change_request_id !== prior.id) {
    throw new Error('SUPPLIER_PROPOSAL_LINK_CONCURRENT_UPDATE')
  }
  return {
    text: `تم تسجيل العرض لدى الإدارة برقم CHG-${prior.code}. حالته ${prior.status}؛ لن نكرر تقديمه. العرض غير معتمد إلا بعد قرار الإدارة.`,
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
  const { data: grant, error: grantError } = await db.from('ai_agent_tool_grants')
    .select('tool_version,permission,constraints')
    .eq('account_id', input.accountId)
    .eq('agent_revision_id', authorization.task.agentRevisionId)
    .eq('tool_key', 'coverage.propose_offer').maybeSingle()
  if (grantError) throw grantError
  const tool = getCurrentPlatformTool('coverage.propose_offer', 2)
  if (!grant || grant.permission !== 'propose' || grant.tool_version !== 2 || !tool) {
    throw new Error('SUPPLIER_PROPOSAL_TOOL_GRANT_MISSING')
  }
  const scoped = authorizeToolInvocation({
    tool, permission: 'propose',
    args: { service_id: request.serviceId, currency: request.currency,
      total_amount: row.offered_amount, attributes: request.attributes },
    constraints: grant.constraints ?? {},
    context: {
      plane: 'customer', channel: 'whatsapp', simulation: false,
      agentPurpose: 'custom',
      trustedAdminIdentityId: null, trustedAdminCapabilities: [],
      agentCapabilities: authorization.capabilities,
      taskAllowedTools: authorization.allowedTools,
      features: {
        killSwitch: runtime.killSwitch,
        nativeToolsEnabled: runtime.nativeToolsEnabled,
        proposalToolsEnabled: runtime.proposalToolsEnabled,
      },
    },
  })
  if (!scoped.ok) throw new Error(scoped.code)
  if ((!row.route_confirmed && !row.route_different) ||
      (row.route_confirmed && row.route_different) ||
      !row.offered_amount || !row.commission_per_thousand || !row.supplier_details) {
    // Old in-flight negotiations with no route confirmation cannot be
    // submitted until the actual supplier accepts the frozen direction.
    throw new Error('SUPPLIER_PROPOSAL_ROUTE_NOT_CONFIRMED')
  }
  if (!row.route_different && supplierNotesConflictWithRoute(
      row.supplier_details, request.route, request.knownRegions)) {
    throw new Error('SUPPLIER_PROPOSAL_ROUTE_CONTRADICTS_SOURCE')
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
  // Check first in case a previous confirmed run committed before a crash.
  const prior = await recoverExistingSupplierProposal(db, input, row, request)
  if (prior) return prior
  let id: string | null = null
  let code: number | null = null
  if (row.route_different) {
    // A counteroffer is NOT an automatically compatible Coverage Offer.
    // Register an explicit admin review, carrying the raw supplier statement
    // and the frozen source direction side-by-side. Approval of the review
    // does not create an active matching offer, reserve funds or satisfy Task.
    const changed = await createChangeRequest({
      accountId: input.accountId,
      actionKey: 'coverage.supplier_counteroffer.review', actionVersion: 1,
      targetType:'coverage_supplier_quote', targetId:null,intent:'create',
      idempotencyKey:`coverage-sourcing:${input.taskId}:${input.taskTargetId}`,
      actorUserId:null, sourceRunId:input.runId,
      proposedPayload:{
        contact_id:input.contactId, conversation_id:input.conversationId,
        source_message_id:input.sourceMessageId,
        source_task_id:input.taskId,source_task_target_id:input.taskTargetId,
        source_coverage_request_id:request.id,
        service_id:request.serviceId,total_amount:row.offered_amount,
        currency:request.currency,commission_per_thousand:row.commission_per_thousand,
        commission_currency:request.currency,
        attributes:inverted,
        supplier_terms:{
          details:row.supplier_details,
          amount:row.offered_amount,currency:request.currency,
          commission_per_thousand:row.commission_per_thousand,
          explicitly_confirmed_in_message_id:input.sourceMessageId,
          route_match:false,
          requested_route:request.route,
          supplier_route_statement:row.supplier_details,
        },
      },
      summary:[
        '⚠️ عرض مورد بديل — مراجعة بشرية فقط، لا ينشئ تغطية مطابقة تلقائيًا.',
        `المورد: ${row.offered_amount} ${request.currency}، العمولة ${row.commission_per_thousand} لكل 1000.`,
        describeSupplierCoverageRoute(request.route),
        `الاختلاف/شروط المورد: ${row.supplier_details.slice(0,500)}`,
      ].join('\n').slice(0,1000),
    })
    id=changed.id
    code=changed.code
  } else {
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
    const payload = outcome.data as { change_request?: { id?: string; code?: number } } | null
    id=payload?.change_request?.id ?? null
    code=payload?.change_request?.code ?? null
  }
  if (!id) throw new Error('SUPPLIER_OFFER_PROPOSAL_NOT_PERSISTED')
  const { data: linked, error } = await db.from('ai_agent_coverage_supplier_negotiations')
    .update({ stage: 'submitted', change_request_id: id, updated_at: new Date().toISOString() })
    .eq('account_id', input.accountId).eq('task_id', input.taskId)
    .eq('task_target_id', input.taskTargetId).eq('stage', 'submitting')
    .eq('confirmation_message_id', input.sourceMessageId)
    .select('change_request_id').maybeSingle()
  if (error) throw error
  if (linked?.change_request_id !== id) {
    throw new Error('SUPPLIER_PROPOSAL_LINK_NOT_PERSISTED')
  }
  return {
    text: row.route_different
      ? `شكرًا لك. رفعت عرضك البديل برقم CHG-${code ?? '—'} للإدارة مع توضيح الاختلاف عن الطلب الأصلي. سيُراجع المسؤول شروطك، ولم تُعتمد التغطية بعد.`
      : `شكرًا لك. رفعت عرضك برقم CHG-${code ?? '—'} للإدارة للمراجعة، ولم يُعتمد بعد. سنتواصل معك بعد القرار.`,
  }
}

/**
 * Older v2 workers parsed supplier replies only after a rigid route stage,
 * dropping a complete first response. Recover only exact signed prior Task
 * runs (same tenant, task, target, conversation, customer sender), and only
 * when the durable negotiation has no amount, rate or terms yet.
 *
 * Rehydration NEVER creates an outbound message or Change Request itself.
 * A NEW signed supplier message is still required for submission.
 */
async function recoverUnrecordedSupplierQuote(
  db: Db,input:SupplierReplyInput,row:TaskSupplierRow,
  request:NonNullable<Awaited<ReturnType<typeof verifiedSupplierContext>>>['request'],
  currentText:string,currentCreatedAt:string,
): Promise<Pick<SupplierTurnState,'offeredAmount'|'commissionPerThousand'|'supplierDetails'>|null> {
  if (!['amount','commission'].includes(row.stage) || row.version<3 ||
      !row.route_confirmed || row.route_different ||
      row.offered_amount!==null || row.commission_per_thousand!==null ||
      row.supplier_details !== null || row.change_request_id !== null ||
      /^(?:تعديل|تغيير|إلغاء|الغاء|لا\s+(?:أستطيع|استطيع))/i.test(currentText)) return null
  const {data:runs,error:re}=await db.from('ai_agent_runs')
    .select('inbound_message_id,created_at').eq('account_id',input.accountId)
    .eq('task_id',input.taskId).eq('task_target_id',input.taskTargetId)
    .eq('run_mode','inbound').eq('status','succeeded')
    .lt('created_at',currentCreatedAt)
    .order('created_at',{ascending:false}).limit(10)
  if(re) throw re
  const ids=[...new Set((runs??[]).map(r=>r.inbound_message_id).filter((x):x is string=>typeof x==='string'))]
  if(!ids.length) return null
  const {data:messages,error:me}=await db.from('messages')
    .select('id,content_text').eq('conversation_id',input.conversationId)
    .eq('sender_type','customer').in('id',ids)
  if(me) throw me
  const byId=new Map((messages??[]).map(m=>[m.id,m.content_text]))
  const facts={remainingAmount:request.remainingAmount,route:request.route,knownRegions:request.knownRegions}
  // Most recent accepted full quote wins, but any later "edit", decline or
  // alternative direction voids automatic recovery.
  for(const run of runs??[]) {
    const text=byId.get(run.inbound_message_id)
    if(typeof text!=='string') continue
    if(/^(?:تعديل|تغيير|إلغاء|الغاء|لا\s+(?:أستطيع|استطيع))/i.test(text)) return null
    const quote=extractSupplierQuote(text,facts)
    if(quote.routeDifference) return null
    if(quote.amount && quote.commission!==null && quote.available &&
       quote.finalConsent && quote.routeAssent && quote.details) {
      return {offeredAmount:quote.amount,commissionPerThousand:quote.commission,
        supplierDetails:quote.details}
    }
  }
  return null
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
  if (row.stage === 'submitting') {
    // Fail closed on a stranded write; only recover an already committed,
    // exact-match Change Request. Never silently re-propose on a later reply.
    try {
      const recovered = await recoverExistingSupplierProposal(db, input, row, verified.request)
      if (recovered) return recovered
    } catch (error) {
      console.warn('[coverage supplier task] interrupted proposal recovery failed', {
        task: input.taskId.slice(0, 8),
        code: error instanceof Error ? error.message : 'unknown',
      })
    }
    const submittedAt = Date.parse(row.updated_at)
    if (!Number.isFinite(submittedAt) || Date.now() - submittedAt >= 5 * 60_000) {
      const { data: held, error } = await db.from('ai_agent_coverage_supplier_negotiations')
        .update({ stage: 'needs_human', updated_at: new Date().toISOString() })
        .eq('account_id', input.accountId).eq('task_id', input.taskId)
        .eq('task_target_id', input.taskTargetId).eq('stage', 'submitting')
        .eq('confirmation_message_id', row.confirmation_message_id)
        .select('stage').maybeSingle()
      if (error) throw error
      if (!held) throw new Error('SUPPLIER_PROPOSAL_RECOVERY_CONCURRENT_UPDATE')
      return { text: 'استلمنا تأكيدك، لكن لم نتمكن من التحقق من تسجيل العرض للإدارة. أحلناه لمتابعة بشرية؛ لن ننشئ عرضًا مكررًا أو ندعي اعتماده.' }
    }
    return { text: 'عرض التغطية قيد التسجيل. سنؤكد رقم الطلب بعد التحقق، ولن ننشئ عرضًا مكررًا.' }
  }
  if (row.stage === 'submitted' && row.change_request_id) {
    const { data: cr, error } = await db.from('change_requests')
      .select('code,status,action_key').eq('account_id', input.accountId)
      .eq('id', row.change_request_id).maybeSingle()
    if (error) throw error
    return { text: cr?.action_key === 'coverage.supplier_counteroffer.review'
      ? cr.status === 'executed'
        ? `راجعت الإدارة عرضك البديل CHG-${cr.code}، وما زال بحاجة إلى اتفاق يدوي على الشروط. لم تُنشأ تغطية مطابقة تلقائيًا.`
        : cr.status === 'rejected' || cr.status === 'cancelled'
          ? `لم توافق الإدارة على العرض البديل CHG-${cr.code}. يمكنك التواصل معها لمناقشة الشروط.`
          : `عرضك البديل CHG-${cr.code} بانتظار مراجعة الإدارة.`
      : cr?.status === 'executed'
      ? `اعتمدت الإدارة عرضك CHG-${cr.code} وتم إنشاء عرض تغطية في النظام. سيتم التواصل معك لاستكمال الإجراءات.`
      : cr?.status === 'rejected' || cr?.status === 'cancelled'
        ? `عرض التغطية CHG-${cr.code} لم يُعتمد. يرجى التواصل مع الإدارة لمراجعة التفاصيل.`
        : `عرضك CHG-${cr?.code ?? '—'} ما زال قيد مراجعة الإدارة، وسيتم التواصل معك بعد القرار.` }
  }
  let current: SupplierTurnState = {
    stage: row.stage, offeredAmount: row.offered_amount,
    commissionPerThousand: row.commission_per_thousand,
    supplierDetails: row.supplier_details,
    routeConfirmed: row.route_confirmed === true,
    routeDifferent: row.route_different === true,
  }
  // Preserve a supplier's already-confirmed, full first message from
  // authenticated prior inbound Task runs instead of asking them to retype
  // amount and commission that the old stage protocol dropped.
  try {
    const recovered=await recoverUnrecordedSupplierQuote(
      db,input,row,verified.request,raw,verified.inbound.created_at,
    )
    if (recovered) current={...current,...recovered}
  } catch (recoveryError) {
    console.warn('[coverage supplier task] old quote rehydration unavailable', {
      code:recoveryError instanceof Error?recoveryError.message:'unknown',
    })
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
    route: verified.request.route, knownRegions: verified.request.knownRegions,
  })
  if (!(await saveStep(db, input, row, step.next))) {
    throw new Error('SUPPLIER_NEGOTIATION_CONCURRENT_UPDATE')
  }
  if (step.action === 'submit') {
    try {
      return await submitConfirmedOffer(db, input,
        { ...row, stage: step.next.stage, offered_amount: step.next.offeredAmount,
          commission_per_thousand: step.next.commissionPerThousand,
          supplier_details: step.next.supplierDetails,
          route_confirmed: step.next.routeConfirmed,
          route_different: step.next.routeDifferent }, verified.request)
    } catch (error) {
      console.error('[coverage supplier task] proposal failed', {
        task: input.taskId.slice(0, 8),
        code: error instanceof Error ? error.message : 'unknown',
      })
      // The Change Request might have committed even if a later intent-link or
      // negotiation update failed. Recover its exact idempotency key first.
      try {
        const recovered = await recoverExistingSupplierProposal(db, input,
          { ...row, ...{
            stage: 'submitting' as const,
            offered_amount: step.next.offeredAmount,
            commission_per_thousand: step.next.commissionPerThousand,
            supplier_details: step.next.supplierDetails,
            confirmation_message_id: input.sourceMessageId,
          } }, verified.request)
        if (recovered) return recovered
      } catch (recoveryError) {
        console.warn('[coverage supplier task] recovery after failure did not verify', {
          task: input.taskId.slice(0, 8),
          code: recoveryError instanceof Error ? recoveryError.message : 'unknown',
        })
      }
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
