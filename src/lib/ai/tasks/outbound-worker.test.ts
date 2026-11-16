import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  loadPolicy: vi.fn(),
  assertCircuit: vi.fn(),
  claim: vi.fn(),
  loadRevision: vi.fn(),
  model: vi.fn(),
  authorize: vi.fn(),
  reserve: vi.fn(),
  delivery: vi.fn(),
  rpc: vi.fn(),
  isTest: vi.fn(),
  transport: vi.fn(),
  preflight: vi.fn(),
  workerEnabled: vi.fn(),
  version: 2,
  taskType: 'coverage.sourcing',
}))

vi.mock('../admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const q = {
        select() { return q },
        eq() { return q },
        lte() { return q },
        order() { return q },
        limit() {
          if (table === 'ai_agent_runs') {
            return Promise.resolve({ data: [{
              id: 'run', account_id: 'account', conversation_id: 'conversation',
              ai_agent_id: 'agent', agent_revision_id: 'revision',
              provider_connection_id: 'ai-provider', plane: 'customer',
              task_id: 'task', task_target_id: 'target',
              counterparty_role: 'coverage_supplier',
            }], error: null })
          }
          throw Error('unexpected list ' + table)
        },
        async maybeSingle() {
          if (table === 'ai_agent_task_targets') {
            return { data: {
              contact_id: 'contact', conversation_id: 'conversation',
              counterparty_role: 'coverage_supplier',
            }, error: null }
          }
          if (table === 'ai_agent_tasks') {
            return { data: {
              task_type: mocked.taskType, task_type_version: mocked.version,
              target_policy: { whatsappConnectionId: 'whatsapp-connection' },
            }, error: null }
          }
          throw Error('unexpected row ' + table)
        },
      }
      return q
    },
    rpc: mocked.rpc,
  }),
}))
vi.mock('../runtime/runtime-policy', () => ({
  loadAccountRuntimePolicy: mocked.loadPolicy,
}))
vi.mock('@/lib/whatsapp/transport/guardrails', () => ({
  isOpenWATestProject: mocked.isTest,
}))
vi.mock('./outbound-message-connection', () => ({
  resolveTaskMessageConnection: mocked.transport,
}))
vi.mock('./test-openwa-task-admission', () => ({
  deferredTestOpenWATaskReason: mocked.preflight,
}))
vi.mock('./operator-controls', () => ({
  isTestAgentTaskWorkerEnabled: mocked.workerEnabled,
}))
vi.mock('../runtime/circuit-breaker', () => ({
  assertRuntimeCircuitClosed: mocked.assertCircuit,
  RuntimeCircuitOpenError: class RuntimeCircuitOpenError extends Error {},
}))
vi.mock('../runtime/execution', () => ({
  claimAgentExecution: mocked.claim,
  loadAgentExecutionRevision: mocked.loadRevision,
  runClaimedAgentExecution: mocked.model,
}))
vi.mock('./capability-policy', () => ({
  authorizeStoredAgentTask: mocked.authorize,
}))
vi.mock('./outbound-runtime', () => ({
  prepareAndReserveCurrentTaskOutboundMessage: mocked.reserve,
}))
vi.mock('./outbound-delivery', () => ({
  deliverAgentTaskOutboundReservation: mocked.delivery,
}))
vi.mock('./current-platform', () => ({
  CURRENT_AGENT_TASK_PLATFORM: {
    taskTypes: {
      get: (name: string, version: number) => name === 'coverage.sourcing'
        ? {
            key: name, version, domain: 'coverage',
            messagePolicy: { key: 'coverage.sourcing_message', version },
          } : null,
    },
    outboundMessagePolicies: {
      get: (name: string, version: number) => name === 'coverage.sourcing_message'
        ? {
            key: name, domain: 'coverage', version,
            ...(version === 2 ? { generation: 'deterministic' } : {}),
          } : null,
    },
  },
}))

import { processAgentTaskOutboundRunQueue } from './outbound-worker'

beforeEach(() => {
  vi.clearAllMocks()
  mocked.version = 2
  mocked.taskType = 'coverage.sourcing'
  mocked.loadPolicy.mockResolvedValue({
    killSwitch: false, multiAgentEnabled: true,
    recoveryWorkerEnabled: true, outboundTaskDeliveryEnabled: true,
  })
  mocked.assertCircuit.mockResolvedValue(undefined)
  mocked.isTest.mockReturnValue(false)
  mocked.transport.mockResolvedValue({
    connectionId: 'whatsapp-connection', provider: 'openwa',
  })
  mocked.preflight.mockResolvedValue(null)
  mocked.workerEnabled.mockResolvedValue(true)
  mocked.claim.mockResolvedValue('claimed')
  mocked.loadRevision.mockResolvedValue({ ok: true, revision: { id: 'revision' } })
  mocked.model.mockResolvedValue({
    status: 'needs_human', error: null, customerMessage: null,
    usage: { inputTokens: 10, outputTokens: 10 },
  })
  mocked.authorize.mockResolvedValue({
    ok: true,
    task: {
      accountId: 'account', agentId: 'agent',
      agentRevisionId: 'revision', taskType: 'coverage.sourcing',
      taskTypeVersion: 2,
    },
  })
  mocked.reserve.mockResolvedValue({
    status: 'reserved',
    decision: { reservationId: 'reservation' },
  })
  mocked.delivery.mockResolvedValue({ status: 'sent' })
  mocked.rpc.mockResolvedValue({ data: 'failed', error: null })
})

describe('TEST outbound transport binding, separate from AI model provider', () => {
  it('never claims a queued Run while the account Task worker is disabled', async () => {
    mocked.isTest.mockReturnValue(true)
    mocked.workerEnabled.mockResolvedValue(false)
    const result = await processAgentTaskOutboundRunQueue({
      workerId: 'worker-disabled', limit: 1,
    })
    expect(result).toMatchObject({ scanned: 1, gated: 1, attempted: 0, sent: 0 })
    expect(mocked.claim).not.toHaveBeenCalled()
    expect(mocked.reserve).not.toHaveBeenCalled()
    expect(mocked.delivery).not.toHaveBeenCalled()
  })

  it('uses the frozen WhatsApp Task connection for preclaim Pilot, retaining AI provider for model revision', async () => {
    mocked.isTest.mockReturnValue(true)
    const result = await processAgentTaskOutboundRunQueue({
      workerId: 'test-agent-task', limit: 1,
    })
    expect(result).toMatchObject({ attempted: 1, gated: 0, sent: 1 })
    expect(mocked.transport).toHaveBeenCalledWith(
      expect.anything(), {
        accountId: 'account', conversationId: 'conversation',
        targetPolicy: { whatsappConnectionId: 'whatsapp-connection' },
      },
    )
    expect(mocked.preflight).toHaveBeenCalledWith({
      db: expect.anything(), accountId: 'account',
      connectionId: 'whatsapp-connection', contactIds: ['contact'],
    })
    expect(mocked.loadRevision).toHaveBeenCalledWith({
      accountId: 'account', agentId: 'agent', revisionId: 'revision',
      providerConnectionId: 'ai-provider',
    })
    expect(mocked.preflight).not.toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ai-provider' }),
    )
  })

  it('leaves outbound Run queued without claiming or reserving when exact WhatsApp grant is missing', async () => {
    mocked.isTest.mockReturnValue(true)
    mocked.preflight.mockResolvedValue('pilot_recipient_not_approved')
    const result = await processAgentTaskOutboundRunQueue({
      workerId: 'test-agent-task', limit: 1,
    })
    expect(result).toMatchObject({ attempted: 0, gated: 1, sent: 0 })
    expect(mocked.claim).not.toHaveBeenCalled()
    expect(mocked.reserve).not.toHaveBeenCalled()
    expect(mocked.delivery).not.toHaveBeenCalled()
  })

  it('does not claim or send when the pinned WhatsApp session is absent or unavailable', async () => {
    mocked.isTest.mockReturnValue(true)
    mocked.transport.mockRejectedValue(new Error('connection_not_ready'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await processAgentTaskOutboundRunQueue({
        workerId: 'test-agent-task', limit: 1,
      })
      expect(result).toMatchObject({ attempted: 0, gated: 1, sent: 0 })
      expect(mocked.claim).not.toHaveBeenCalled()
      expect(mocked.reserve).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })
})

describe('SOF-63 deterministic domain outbound policy', () => {
  it('reserves deterministic Coverage V2 without asking the LLM to handoff', async () => {
    const outcome = await processAgentTaskOutboundRunQueue({ workerId: 'sof63', limit: 1 })
    expect(outcome).toMatchObject({
      attempted: 1, reserved: 1, sent: 1, failed: 0, denied: 0,
    })
    expect(mocked.authorize).toHaveBeenCalledOnce()
    expect(mocked.model).not.toHaveBeenCalled()
    expect(mocked.reserve).toHaveBeenCalledWith({
      runId: 'run', modelCandidateText: null,
    })
    expect(mocked.delivery).toHaveBeenCalledWith({
      reservationId: 'reservation', workerId: 'sof63',
      inputTokens: 0, outputTokens: 0,
    })
  })

  it('fails closed if the frozen Task authorization cannot be verified', async () => {
    mocked.authorize.mockResolvedValue({ ok: false, code: 'AGENT_CAPABILITY_MISSING' })
    const outcome = await processAgentTaskOutboundRunQueue({ workerId: 'sof63', limit: 1 })
    expect(outcome.failed).toBe(1)
    expect(outcome.sent).toBe(0)
    expect(mocked.reserve).not.toHaveBeenCalled()
    expect(mocked.rpc).toHaveBeenCalledWith('fail_agent_task_outbound_run',
      expect.objectContaining({ p_error_code: 'AGENT_CAPABILITY_MISSING' }))
  })

  it('fails closed when the authorized revision does not match the claimed run', async () => {
    mocked.authorize.mockResolvedValue({
      ok: true,
      task: {
        accountId: 'foreign-account', agentId: 'agent',
        agentRevisionId: 'revision', taskType: 'coverage.sourcing', taskTypeVersion: 2,
      },
    })
    const outcome = await processAgentTaskOutboundRunQueue({ workerId: 'sof63', limit: 1 })
    expect(outcome.failed).toBe(1)
    expect(mocked.reserve).not.toHaveBeenCalled()
  })

  it('preserves legacy model-first V1 handoff and never sends', async () => {
    mocked.version = 1
    const outcome = await processAgentTaskOutboundRunQueue({ workerId: 'sof63', limit: 1 })
    expect(outcome.failed).toBe(1)
    expect(outcome.sent).toBe(0)
    expect(mocked.model).toHaveBeenCalledOnce()
    expect(mocked.reserve).not.toHaveBeenCalled()
    expect(mocked.authorize).not.toHaveBeenCalled()
  })

  it('honors kill switch and never claims or reserves on a disabled runtime', async () => {
    mocked.loadPolicy.mockResolvedValue({
      killSwitch: true, multiAgentEnabled: true,
      recoveryWorkerEnabled: true, outboundTaskDeliveryEnabled: true,
    })
    const outcome = await processAgentTaskOutboundRunQueue({ workerId: 'sof63', limit: 1 })
    expect(outcome.gated).toBe(1)
    expect(outcome.attempted).toBe(0)
    expect(mocked.claim).not.toHaveBeenCalled()
    expect(mocked.reserve).not.toHaveBeenCalled()
  })
})
