import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { normalizeAgentTaskWorkerLimit } from './orchestrator'

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
})
