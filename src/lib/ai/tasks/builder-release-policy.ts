/**
 * Phase 21 (SOF-26) — dormant, pure rollout *policy contract* for the
 * outbound Agent Task Builder. NOT connected to send, publish, create,
 * trigger, worker, or account authorization routes yet.
 *
 * Server-authenticated role/account and independently reviewed acceptance
 * evidence must be supplied by a future server-side rollout controller;
 * never accept these inputs from the browser/model or treat env vars alone
 * as signed acceptance. Existing reactive/inbound Builder is unaffected.
 */
import type { AccountRole } from '@/lib/auth/roles'

export const AGENT_TASK_BUILDER_ROLLOUT_STAGES = [
  'disabled',
  'internal',
  'owner',
  'selected_accounts',
  'capability_admins',
  'general_availability',
] as const
export type AgentTaskBuilderRolloutStage =
  (typeof AGENT_TASK_BUILDER_ROLLOUT_STAGES)[number]

/** Each must have an independently reviewable TEST/security evidence link
 * and an accountable operator signoff before moving stages. A green CI
 * alone is not sufficient. */
export const AGENT_TASK_BUILDER_RELEASE_GATES = [
  'sch6_live_acceptance',
  'coverage_multi_target_acceptance',
  'coverage_negative_handoff_acceptance',
  'cutover_rollback_verified',
  'no_unsettled_provider_outcomes',
  'tenant_role_security_approved',
  'meta_openwa_policy_verified',
  'builder_reactive_parity_verified',
  'manual_rtl_mobile_accessibility_review',
  'ops_owner_and_rollback_plan_approved',
] as const
export type AgentTaskBuilderReleaseGate =
  (typeof AGENT_TASK_BUILDER_RELEASE_GATES)[number]

export type AgentTaskBuilderReviewedEvidence = Readonly<Partial<
  Record<AgentTaskBuilderReleaseGate, Readonly<{
    passed: boolean
    evidenceRef: string
    approvedBy: string
  }>>
>>

export interface AgentTaskBuilderReleaseContext {
  /** Must be read from an authenticated server membership, not JSON input. */
  accountId: string
  role: AccountRole
  /** Scoped to agents.manage_tasks; verified on the server. */
  hasManageTasksCapability: boolean
  /** Confirmed operator identity in a protected internal registry. */
  internalOperator: boolean
  /** Exact, server-owned account allowlist for bounded release. */
  selectedAccountIds: readonly string[]
  requestedStage: AgentTaskBuilderRolloutStage
  evidence: AgentTaskBuilderReviewedEvidence
  /** Distinct release-manager signature backed by a real approval record. */
  releaseApproved: boolean
  /** The only V1 task type permitted by this proposed gated rollout. */
  taskType: string
  taskVersion: number
}

export interface AgentTaskBuilderReleaseDecision {
  readonly allowed: boolean
  readonly stage: AgentTaskBuilderRolloutStage
  readonly taskType: string
  readonly taskVersion: number
  readonly reasons: readonly string[]
  readonly missingEvidence: readonly AgentTaskBuilderReleaseGate[]
  readonly meaning: 'builder_feature_visibility_only'
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REF = /^[a-zA-Z0-9][a-zA-Z0-9._:/#@-]{7,511}$/
const APPROVER = /^[a-zA-Z0-9][a-zA-Z0-9._@:-]{2,127}$/

export function evaluateAgentTaskBuilderRollout(
  input: AgentTaskBuilderReleaseContext,
): AgentTaskBuilderReleaseDecision {
  const reasons: string[] = []
  const missingEvidence = AGENT_TASK_BUILDER_RELEASE_GATES.filter(gate => {
    const record = input.evidence[gate]
    return record?.passed !== true ||
      typeof record.evidenceRef !== 'string' || !REF.test(record.evidenceRef) ||
      typeof record.approvedBy !== 'string' || !APPROVER.test(record.approvedBy)
  })
  const stage = AGENT_TASK_BUILDER_ROLLOUT_STAGES.includes(input.requestedStage)
    ? input.requestedStage : 'disabled'

  if (!UUID.test(input.accountId)) reasons.push('account_identity_invalid')
  if (stage === 'disabled') reasons.push('rollout_disabled')
  if (input.releaseApproved !== true) reasons.push('release_signature_missing')
  if (missingEvidence.length) reasons.push('acceptance_evidence_missing')
  if (!input.hasManageTasksCapability || !['owner','admin'].includes(input.role)) {
    reasons.push('operator_capability_missing')
  }
  // Promotion V1/V2 and arbitrary future domains MUST NOT inherit Coverage
  // acceptance merely because they share a generic Task Kernel/Builder.
  if (input.taskType !== 'coverage.sourcing' || input.taskVersion !== 2) {
    reasons.push('task_type_not_accepted_for_release')
  }
  const rank = AGENT_TASK_BUILDER_ROLLOUT_STAGES.indexOf(stage)
  const isOwner = input.role === 'owner'
  const inSelectedCohort = input.selectedAccountIds.some(
    id => UUID.test(id) && id === input.accountId,
  )
  const audienceAllowed =
    (rank >= 1 && input.internalOperator === true) ||
    (rank >= 2 && isOwner) ||
    (rank >= 3 && inSelectedCohort) ||
    (rank >= 4 && input.hasManageTasksCapability)
  if (!audienceAllowed) reasons.push('not_in_release_cohort')

  return {
    allowed: reasons.length === 0,
    stage,
    taskType: input.taskType,
    taskVersion: input.taskVersion,
    reasons,
    missingEvidence,
    // This NEVER grants WhatsApp send, recipient consent, publication,
    // agent tool capabilities, cutover, or worker execution authority.
    meaning: 'builder_feature_visibility_only',
  }
}
