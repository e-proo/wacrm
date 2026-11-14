import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { deferredTargetAdmission, normalizeAgentTaskWorkerLimit } from './orchestrator'

describe('Task Orchestrator', () => {
  it('bounds worker batches', () => {
    expect(normalizeAgentTaskWorkerLimit()).toBe(20)
    expect(normalizeAgentTaskWorkerLimit(0)).toBe(1)
    expect(normalizeAgentTaskWorkerLimit(5)).toBe(5)
    expect(normalizeAgentTaskWorkerLimit(999)).toBe(100)
  })

  it('keeps outbound transport outside the Phase 5 orchestrator', () => {
    const source = readFileSync(
      new URL('./orchestrator.ts', import.meta.url),
      'utf8',
    )

    expect(source).toContain("rpc('claim_next_agent_task'")
    expect(source).toContain("rpc('claim_next_agent_task_target'")
    expect(source).toContain('materializeCurrentTaskTargets')
    expect(source).toContain("rpc('create_claimed_agent_task_execution'")
    expect(source).toContain('authorizeStoredAgentTask')
    expect(source).toContain("rpc('fail_claimed_agent_task_policy'")
    expect(source).not.toContain('engineSendText')
    expect(source).not.toContain('meta-send')
    expect(source).not.toContain('runClaimedAgentExecution')
  })

  it('uses SQL-owned pause, cancel, retry and lease recovery boundaries', () => {
    const source = readFileSync(
      new URL('./orchestrator.ts', import.meta.url),
      'utf8',
    )

    expect(source).toContain("rpc('sweep_agent_task_claims'")
    expect(source).toContain("rpc('retry_agent_task_target_claim'")
    expect(source).toContain("rpc('pause_agent_task'")
    expect(source).toContain("rpc('resume_agent_task'")
    expect(source).toContain("rpc('cancel_agent_task'")
  })
  it('defers a supplier in contact cooldown instead of terminally exhausting a Task', () => {
    expect(deferredTargetAdmission({
      considered: 1, accepted: 0,
      decisions: [{ contactId: 'one', accepted: false, reason: 'contact_cooldown',
        targetId: null, conversationId: null }],
    })).toEqual({ delaySeconds: 300, reasons: ['contact_cooldown'] })
  })

  it('defers transient account/agent target caps and keeps the strongest delay', () => {
    expect(deferredTargetAdmission({
      considered: 3, accepted: 0,
      decisions: [
        { contactId: 'one', accepted: false, reason: 'account_hourly_contact_limit', targetId: null, conversationId: null },
        { contactId: 'two', accepted: false, reason: 'contact_cooldown', targetId: null, conversationId: null },
        { contactId: 'three', accepted: false, reason: 'agent_daily_contact_limit', targetId: null, conversationId: null },
      ],
    })).toEqual({ delaySeconds: 3600,
      reasons: ['account_hourly_contact_limit','contact_cooldown','agent_daily_contact_limit'] })
  })

  it('never treats no supplier, permanent suppression, duplicates, or acceptance as transient', () => {
    const row = (reason: string, accepted=false) =>
      ({ contactId: 'one', accepted, reason, targetId: null, conversationId: null })
    expect(deferredTargetAdmission({ considered: 0, accepted: 0, decisions: [] })).toBe(null)
    expect(deferredTargetAdmission({ considered: 1, accepted: 0, decisions: [row('suppressed')] })).toBe(null)
    expect(deferredTargetAdmission({ considered: 1, accepted: 0, decisions: [row('duplicate')] })).toBe(null)
    expect(deferredTargetAdmission({ considered: 2, accepted: 0, decisions: [row('contact_cooldown'), row('suppressed')] })).toBe(null)
    expect(deferredTargetAdmission({ considered: 1, accepted: 1, decisions: [row('eligible', true)] })).toBe(null)
    expect(deferredTargetAdmission({ considered: 2, accepted: 0, decisions: [row('contact_cooldown')] })).toBe(null)
  })

  it('releases temporary denials before evaluating the terminal completion policy', () => {
    const source = readFileSync(new URL('./orchestrator.ts', import.meta.url), 'utf8')
    const deferred = source.indexOf('const temporaryAdmission = deferredTargetAdmission(resolution)')
    const completed = source.indexOf('const completion = await evaluateCurrentTaskCompletion(taskId)')
    expect(deferred).toBeGreaterThan(-1)
    expect(completed).toBeGreaterThan(deferred)
    expect(source).toContain('await releaseTaskClaim(\n            db, taskId, input.workerId, temporaryAdmission.delaySeconds,')
  })

})
