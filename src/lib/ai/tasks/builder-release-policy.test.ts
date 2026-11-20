import { describe, expect, it } from 'vitest'
import {
  AGENT_TASK_BUILDER_RELEASE_GATES,
  AGENT_TASK_BUILDER_ROLLOUT_STAGES,
  evaluateAgentTaskBuilderRollout,
  type AgentTaskBuilderReleaseContext,
} from './builder-release-policy'

const ACCOUNT = '8ed95309-96cd-4347-b725-bd8c5039ed4f'
const OTHER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const completeEvidence = () => Object.fromEntries(
  AGENT_TASK_BUILDER_RELEASE_GATES.map(gate => [
    gate,
    { passed: true, evidenceRef: 'https://example.test/verified/' + gate,
      approvedBy: 'reviewer-operator-1' },
  ]),
)
const base = (): AgentTaskBuilderReleaseContext => ({
  accountId: ACCOUNT,
  role: 'owner',
  hasManageTasksCapability: true,
  internalOperator: false,
  selectedAccountIds: [],
  requestedStage: 'disabled',
  evidence: {},
  releaseApproved: false,
  taskType: 'coverage.sourcing',
  taskVersion: 2,
})
const approved = (): AgentTaskBuilderReleaseContext => ({
  ...base(),
  releaseApproved: true,
  evidence: completeEvidence(),
})

describe('SOF-26 Phase 21 staged Builder rollout policy — dormant contract', () => {
  it('defaults to HOLD even for owner, with all acceptance requirements missing', () => {
    const result = evaluateAgentTaskBuilderRollout(base())
    expect(result.allowed).toBe(false)
    expect(result.reasons).toContain('rollout_disabled')
    expect(result.reasons).toContain('release_signature_missing')
    expect(result.missingEvidence).toEqual(AGENT_TASK_BUILDER_RELEASE_GATES)
    expect(result.meaning).toBe('builder_feature_visibility_only')
  })
  it('cannot accept just green CI, unilateral flag, or incomplete signoffs', () => {
    const input = approved()
    const missing = { ...input.evidence, sch6_live_acceptance: undefined }
    const noSchedulerAcceptance = evaluateAgentTaskBuilderRollout({
      ...input, evidence: missing, requestedStage: 'general_availability',
    })
    expect(noSchedulerAcceptance.allowed).toBe(false)
    expect(noSchedulerAcceptance.missingEvidence).toContain('sch6_live_acceptance')
    expect(evaluateAgentTaskBuilderRollout({
      ...input, releaseApproved: false, requestedStage: 'general_availability',
    }).reasons).toContain('release_signature_missing')
    expect(evaluateAgentTaskBuilderRollout({
      ...input, requestedStage: 'general_availability',
      evidence: { ...input.evidence, cutover_rollback_verified:
        {passed: true, evidenceRef: '', approvedBy: 'reviewer'} },
    }).allowed).toBe(false)
  })
  it('allows internal only for authenticated capability holders verified as internal operators', () => {
    const context = { ...approved(), requestedStage: 'internal' as const }
    expect(evaluateAgentTaskBuilderRollout(context).allowed).toBe(false)
    expect(evaluateAgentTaskBuilderRollout({ ...context, internalOperator: true }).allowed).toBe(true)
    expect(evaluateAgentTaskBuilderRollout({
      ...context, internalOperator: true, role: 'viewer',
    }).allowed).toBe(false)
    expect(evaluateAgentTaskBuilderRollout({
      ...context, internalOperator: true, hasManageTasksCapability: false,
    }).allowed).toBe(false)
  })
  it('moves through owner, selected-account and capable-admin cohorts monotonically', () => {
    const ctx = approved()
    expect(evaluateAgentTaskBuilderRollout({...ctx, requestedStage:'owner'}).allowed).toBe(true)
    expect(evaluateAgentTaskBuilderRollout({...ctx, requestedStage:'owner',role:'admin'}).allowed).toBe(false)
    expect(evaluateAgentTaskBuilderRollout({...ctx, requestedStage:'selected_accounts',role:'admin',
      selectedAccountIds:[OTHER]}).allowed).toBe(false)
    expect(evaluateAgentTaskBuilderRollout({...ctx, requestedStage:'selected_accounts',role:'admin',
      selectedAccountIds:[ACCOUNT]}).allowed).toBe(true)
    expect(evaluateAgentTaskBuilderRollout({...ctx, requestedStage:'capability_admins',role:'admin'}).allowed).toBe(true)
    expect(evaluateAgentTaskBuilderRollout({...ctx, requestedStage:'general_availability',role:'admin'}).allowed).toBe(true)
    expect(AGENT_TASK_BUILDER_ROLLOUT_STAGES).toEqual([
      'disabled','internal','owner','selected_accounts','capability_admins','general_availability',
    ])
  })
  it('never releases deferred Service Promotion, V1 Coverage or unregistered domains', () => {
    const ctx = {...approved(),requestedStage:'general_availability' as const}
    for (const [taskType,taskVersion] of [
      ['services.promotion',1],['services.promotion',2],['coverage.sourcing',1],
      ['fx.outreach',1],['receivables.followup',1],
    ] as const) {
      const verdict=evaluateAgentTaskBuilderRollout({...ctx,taskType,taskVersion})
      expect(verdict.allowed).toBe(false)
      expect(verdict.reasons).toContain('task_type_not_accepted_for_release')
    }
  })
  it('never derives role or account identity from invalid input', () => {
    const ctx={...approved(),requestedStage:'general_availability' as const}
    expect(evaluateAgentTaskBuilderRollout({...ctx,accountId:'bad-account'}).allowed).toBe(false)
    expect(evaluateAgentTaskBuilderRollout({...ctx,role:'agent'}).allowed).toBe(false)
    expect(evaluateAgentTaskBuilderRollout({...ctx,role:'viewer'}).allowed).toBe(false)
    expect(evaluateAgentTaskBuilderRollout({...ctx,hasManageTasksCapability:false}).allowed).toBe(false)
  })
})
