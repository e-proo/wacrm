import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { normalizeTaskReplyCorrelation } from './reply-correlation'

describe('Task reply correlation runtime', () => {
  it('normalizes a durable matched routing signal', () => {
    expect(
      normalizeTaskReplyCorrelation({
        status: 'matched',
        reason: 'matched',
        run_id: 'run-1',
        task_id: 'task-1',
        task_target_id: 'target-1',
        agent_id: 'agent-1',
        agent_revision_id: 'rev-1',
        provider_connection_id: 'conn-1',
        counterparty_role: 'supplier',
        correlation_method: 'reply_context',
      }),
    ).toEqual({
      status: 'matched',
      reason: 'matched',
      signal: {
        runId: 'run-1',
        taskId: 'task-1',
        taskTargetId: 'target-1',
        agentId: 'agent-1',
        revisionId: 'rev-1',
        providerConnectionId: 'conn-1',
        counterpartyRole: 'supplier',
        correlationMethod: 'reply_context',
      },
      candidateCount: null,
      pausedTargets: null,
    })
  })

  it('keeps ambiguous replies fail-closed without inventing a routing signal', () => {
    expect(
      normalizeTaskReplyCorrelation({
        status: 'ambiguous',
        reason: 'multiple_active_task_targets',
        candidate_count: 2,
      }),
    ).toEqual({
      status: 'ambiguous',
      reason: 'multiple_active_task_targets',
      signal: null,
      candidateCount: 2,
      pausedTargets: null,
    })
  })

  it('requires complete frozen routing provenance for matched rows', () => {
    expect(() =>
      normalizeTaskReplyCorrelation({
        status: 'matched',
        reason: 'matched',
        run_id: 'run-1',
      }),
    ).toThrow(/TASK_REPLY_CORRELATION_FIELD_MISSING/)
  })
})

describe('Task reply integration boundaries', () => {
  it('reuses the correlated run and carries task provenance through dispatch', () => {
    const source = readFileSync(
      new URL('../runtime/dispatch.ts', import.meta.url),
      'utf8',
    )

    expect(source).toContain('return decision.taskReply.runId')
    expect(source).toContain('taskId: decision.taskReply?.taskId ?? null')
    expect(source).toContain(
      'taskTargetId: decision.taskReply?.taskTargetId ?? null',
    )
    expect(source).toContain(
      "decision.plane === 'customer' && !decision.taskReply",
    )
  })

  it('keeps trusted-admin routing before task correlation in the webhook', () => {
    const source = readFileSync(
      new URL('../../../app/api/whatsapp/webhook/route.ts', import.meta.url),
      'utf8',
    )

    const admin = source.indexOf('resolveTrustedAdminIdentity({')
    const task = source.indexOf('correlateInboundTaskReply({')
    const flows = source.indexOf('dispatchInboundToFlows({')

    expect(admin).toBeGreaterThanOrEqual(0)
    expect(task).toBeGreaterThan(admin)
    expect(flows).toBeGreaterThan(task)
  })

  it('allows Meta replay recovery only through idempotent task correlation', () => {
    const source = readFileSync(
      new URL('../../../app/api/whatsapp/webhook/route.ts', import.meta.url),
      'utf8',
    )

    expect(source).toContain('const isInboundReplay =')
    expect(source).toContain("workerId: isInboundReplay ? 'webhook-task-replay'")
    expect(source).toContain('if (isInboundReplay) return')

    const task = source.indexOf('correlateInboundTaskReply({')
    const replayExit = source.lastIndexOf('if (isInboundReplay) return')
    expect(replayExit).toBeGreaterThan(task)
  })
})
